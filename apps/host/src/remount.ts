import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";

export const OVERRIDE_FILE = "docker-compose.override.yml";
const GEN_TIMEOUT_MS = 120_000;
const UP_TIMEOUT_MS = 300_000;
/** How much of a failed command's stderr goes into the log. */
const STDERR_TAIL = 2_000;

export interface ExecOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

/** Runs a program without a shell, like a promisified `execFile`. */
export type ExecFn = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
) => Promise<{ stdout: string; stderr: string }>;

export interface RemountOptions {
  /** The majhi checkout holding docker-compose.yml. */
  repo: string;
  /** Absolute path of `docker`. */
  docker: string;
  /** Environment for `docker compose`: the owner's HOME, HOST_UID, HOST_GID and a PATH with Docker on it. */
  env: NodeJS.ProcessEnv;
  exec: ExecFn;
  log: Logger;
  /** Absolute `.pub` files to mount read-only. Only the host can tell which exist. */
  sshPublicKeys?: () => Promise<string[]>;
}

/** The environment `make up` gives `docker compose`, so a remount starts majhi the same way. */
export function composeEnv(
  base: NodeJS.ProcessEnv,
  owner: { home: string; uid: number; gid: number; path: string },
): NodeJS.ProcessEnv {
  return {
    ...base,
    HOME: owner.home,
    HOST_UID: String(owner.uid),
    HOST_GID: String(owner.gid),
    PATH: owner.path,
    // Days of tokens and cost follow this computer's zone, as with `make up`.
    MAJHI_TZ: base.MAJHI_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * Returns a function that regenerates `docker-compose.override.yml` from
 * majhi.yaml and recreates the server container, one run at a time. A run
 * never throws: the server was already told the remount started, so failures
 * go to the log.
 */
export function createRemounter(options: RemountOptions): () => Promise<boolean> {
  let queue: Promise<unknown> = Promise.resolve();
  return () => {
    const run = queue.then(() => remount(options));
    queue = run;
    return run;
  };
}

/** Runs one `docker` step and throws a plain error, with the tail of stderr, when it fails. */
export function dockerStep(
  { repo, docker, env, exec, log }: Pick<RemountOptions, "repo" | "docker" | "env" | "exec" | "log">,
  prefix: string,
) {
  return async (
    label: string,
    args: string[],
    timeout: number,
    stepEnv: NodeJS.ProcessEnv = env,
  ): Promise<string> => {
    log(`${prefix}: ${label}: docker ${args.join(" ")}`);
    try {
      return (await exec(docker, args, { cwd: repo, env: stepEnv, timeout })).stdout;
    } catch (err) {
      const detail = typeof err === "object" && err !== null ? err : {};
      // execFile's message repeats all of stderr after its first line. Keep the line, add a tail.
      const reason =
        "killed" in detail && detail.killed === true
          ? `timed out after ${Math.round(timeout / 1000)}s`
          : (errorMessage(err).split("\n", 1)[0] ?? "");
      const tail = ("stderr" in detail ? String(detail.stderr) : "").trim().slice(-STDERR_TAIL);
      throw new Error(`${label} failed: ${reason}${tail === "" ? "" : `\n${tail}`}`);
    }
  };
}

async function remount(options: RemountOptions): Promise<boolean> {
  const started = Date.now();
  const target = join(options.repo, OVERRIDE_FILE);
  try {
    await regenerateAndUp(options, "remount");
    options.log(`remount: done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  } catch (err) {
    await rm(`${target}.${process.pid}.tmp`, { force: true });
    options.log(`remount: ${errorMessage(err)}`);
    return false;
  }
}

/**
 * Regenerates `docker-compose.override.yml` from majhi.yaml with the image on disk, then starts
 * (or recreates) majhi and waits until it is healthy. Throws with the failed step's reason.
 * `onStep` hears the plain-words name of each step as it starts.
 */
export async function regenerateAndUp(
  options: RemountOptions,
  prefix: string,
  onStep: (text: string) => void = () => undefined,
): Promise<void> {
  const { repo, env, sshPublicKeys, log } = options;
  const target = join(repo, OVERRIDE_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  const step = dockerStep(options, prefix);
  const keys = sshPublicKeys === undefined ? [] : await sshPublicKeys().catch(() => []);
  onStep("Generating the folder mounts");
  const override = await step(
    "generate mounts",
    [
      "compose",
      "run",
      "--rm",
      "--no-deps",
      "-T",
      "-e",
      "MAJHI_SSH_PUBKEYS",
      "-e",
      "MAJHI_SSH_AGENT",
      "-e",
      "MAJHI_LAYA_GPU",
      "server",
      "node",
      "dist/cli.js",
      "gen-override",
    ],
    GEN_TIMEOUT_MS,
    { ...env, MAJHI_SSH_PUBKEYS: keys.join("\n") },
  );
  if (override.trim() === "") throw new Error("generate mounts printed nothing, so the override was kept");
  await writeFile(temp, override);
  await rename(temp, target);
  log(`${prefix}: wrote ${target}`);
  onStep("Starting the new majhi and waiting until it is healthy");
  await step("restart majhi", ["compose", "up", "-d", "--wait"], UP_TIMEOUT_MS);
}
