import { randomBytes } from "node:crypto";
import { redactText } from "../admin/policy.ts";
import { DBCHECK_TASK, dbCheckRunArgs, type HostPaths, type Safety } from "./args.ts";
import type { ContainerDocker } from "./service.ts";

const MAX_OUT = 64 * 1024;
export const MAJHI_DOCKER =
  "majhi problem: Docker is not available to the server, so this check cannot run its client image.";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Why a run could not give an answer. The message is safe to show: it never holds the database's own text. */
export class ImageCheckFailed extends Error {}

/**
 * Runs the client of a database's official image once, in a throwaway container (`--rm`, read-only root,
 * no mount, limits), with the connection's values as environment for this run only, and returns what it
 * printed. The image is pulled on first use by `docker run` itself.
 */
export async function runImageCheck(
  docker: ContainerDocker | undefined,
  paths: HostPaths,
  input: { image: string; command: readonly string[]; env: Record<string, string> },
  timeoutMs: number,
): Promise<string> {
  if (docker === undefined) throw new ImageCheckFailed(MAJHI_DOCKER);
  const env = Object.fromEntries(
    Object.entries(input.env).filter(
      ([k, v]) => ENV_NAME.test(k) && v.length <= 4_000 && !v.includes("\u0000"),
    ),
  );
  const safety: Safety = { ...paths, task: DBCHECK_TASK, runnerNetwork: "", taskFolder: "/" };
  const name = `majhi-dbcheck-${randomBytes(6).toString("hex")}`;
  const parts = dbCheckRunArgs(name, input.image, input.command, env, { cpus: 1, memory: "512m" }, safety);
  const run = await docker.attached(parts, safety);
  return new Promise<string>((resolve, reject) => {
    let out = "";
    let done = false;
    const finish = (err?: ImageCheckFailed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      run.kill();
      if (err === undefined) resolve(out.trim());
      else reject(err);
    };
    const timer = setTimeout(() => finish(new ImageCheckFailed("no answer in time")), timeoutMs);
    run.child.stdout?.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (out.length > MAX_OUT) finish(new ImageCheckFailed("the answer is too large"));
    });
    // The last of what the program said on stderr, so a failure names its cause. Never the answer.
    let err = "";
    run.child.stderr?.on("data", (d: Buffer) => {
      err = (err + d.toString("utf8")).slice(-ERR_TAIL);
    });
    run.child.once("error", () => finish(new ImageCheckFailed(MAJHI_DOCKER)));
    run.child.once("close", (code) => {
      if (code === 0) finish();
      else if (code === 125)
        finish(new ImageCheckFailed("majhi problem: Docker could not start or pull the client image."));
      else if (code === 126 || code === 127)
        finish(new ImageCheckFailed("majhi problem: the client program is missing from the image."));
      else finish(new ImageCheckFailed(failureLine(code, hideValues(err, Object.values(env)))));
    });
  });
}

/** How much of stderr a failure keeps. */
const ERR_TAIL = 600;

/** stderr with every value the program was given (tokens, passwords) and every detected secret hidden. */
export function hideValues(text: string, values: readonly string[]): string {
  let out = text;
  for (const v of values) if (v.length >= 6) out = out.split(v).join("[redacted]");
  return redactText(out);
}

/** "The program exited 1: <its last error line>", trimmed to one short line. */
export function failureLine(code: number | null, stderr: string): string {
  const said = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(-3)
    .join(" ")
    .slice(0, 300);
  const exit = code === null ? "stopped" : `exited ${code}`;
  return said === "" ? `the program ${exit} without saying why` : `the program ${exit}: ${said}`;
}
