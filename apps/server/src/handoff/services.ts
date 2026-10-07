import { randomBytes } from "node:crypto";
import type { CiService } from "../ci/jobs.ts";
import type { ExecResult } from "./service.ts";

/**
 * The services a CI job starts next to its steps (a database, a cache), started for a hand-off check the
 * way the CI does: the same image, environment, ports and health check the job declares. They run as
 * containers beside the check, through the same `docker` the check itself has (majhi's shim in a runner,
 * the machine's own docker when checks run on it), and are removed when the check ends.
 */

type Exec = (command: string, timeoutMs: number) => Promise<ExecResult>;

export type StartedServices =
  | { ok: true; names: string[]; notes: string[]; stop: () => Promise<void> }
  | { ok: false; why: string };

/** How long a service gets to start and, when the job gives a health check, to turn healthy. */
const READY_MS = 3 * 60_000;
const CALL_MS = 2 * 60_000;
const POLL_SECONDS = 2;
/** Without a health check the job's steps start once the container has been up this long. */
const SETTLE_SECONDS = 3;

/** One shell word: single quotes around it, with any single quote inside closed and written out. */
function quote(word: string): string {
  return `'${word.split("'").join(`'\\''`)}'`;
}

const line = (argv: string[]): string => argv.map(quote).join(" ");

/** A container name docker takes: lowercase letters, digits and `-_.`, starting with a letter or digit. */
function containerName(run: string, service: string): string {
  const clean = [...service.toLowerCase()].map((c) =>
    "abcdefghijklmnopqrstuvwxyz0123456789-_.".includes(c) ? c : "-",
  );
  return `chk${run}-${clean.join("").slice(0, 24)}`;
}

/** The `docker run` of one service. Only what the job declares goes in: the image, its variables, its ports and its health check. */
export function runLine(name: string, svc: CiService): string {
  const argv = ["docker", "run", "-d", "--name", name];
  for (const [k, v] of Object.entries(svc.env)) argv.push("-e", `${k}=${v}`);
  for (const port of svc.ports) argv.push("-p", port);
  if (svc.health !== undefined) {
    argv.push("--health-cmd", svc.health.cmd);
    if (svc.health.interval !== undefined) argv.push("--health-interval", svc.health.interval);
    if (svc.health.timeout !== undefined) argv.push("--health-timeout", svc.health.timeout);
    if (svc.health.retries !== undefined) argv.push("--health-retries", String(svc.health.retries));
  }
  argv.push(svc.image);
  return line(argv);
}

/** A shell loop that ends 0 once the container is up (and healthy, when it has a health check), 1 when it is not in time. */
export function waitLine(name: string, svc: CiService): string {
  const tries = Math.ceil(READY_MS / 1000 / POLL_SECONDS) - 10;
  const state = svc.health === undefined ? "{{.State.Running}}" : "{{.State.Health.Status}}";
  const want = svc.health === undefined ? "true" : "healthy";
  const settle = svc.health === undefined ? `sleep ${SETTLE_SECONDS}; ` : "";
  return `i=0; while [ "$i" -lt ${tries} ]; do s=$(docker inspect -f ${quote(state)} ${quote(name)} 2>/dev/null); if [ "$s" = ${quote(want)} ]; then ${settle}exit 0; fi; i=$((i+1)); sleep ${POLL_SECONDS}; done; exit 1`;
}

/** What a failed start says, in a line: the last thing docker printed, or why it could not be called. */
function reason(res: ExecResult): string {
  const last = res.log
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .pop();
  const said = res.error ?? last ?? "no reason given";
  const text = said.length > 200 ? `${said.slice(0, 199)}…` : said;
  const missing = ["not found", "Cannot connect", "daemon", "no such file"].some((w) => said.includes(w));
  return missing ? `Docker is not available where checks run (${text})` : text;
}

/**
 * Starts every service of a job. When one cannot start, the ones already started are removed and the
 * answer says which one and why, so the check is not run against a database that is not there.
 */
export async function startServices(exec: Exec, services: readonly CiService[]): Promise<StartedServices> {
  const run = randomBytes(3).toString("hex");
  const started: string[] = [];
  const notes: string[] = [];
  const stop = async (): Promise<void> => {
    if (started.length === 0) return;
    const names = started.splice(0, started.length);
    await exec(`docker rm -f ${names.map(quote).join(" ")}`, CALL_MS).catch(() => undefined);
  };
  for (const svc of services) {
    const name = containerName(run, svc.name);
    const failed = async (why: string): Promise<StartedServices> => {
      await stop();
      return {
        ok: false,
        why: `The ${svc.name} service (${svc.image}) that the CI starts for this check did not start: ${why}. The check was not run. Docker has to work where majhi runs checks. If majhi asked you in the room to allow the image, answer there, then check again`,
      };
    };
    const up = await exec(runLine(name, svc), CALL_MS);
    if (up.error !== undefined || up.timedOut || up.code !== 0) {
      return failed(up.timedOut ? "docker did not answer in time" : reason(up));
    }
    started.push(name);
    const ready = await exec(waitLine(name, svc), READY_MS + CALL_MS);
    if (ready.error !== undefined || ready.timedOut || ready.code !== 0) {
      return failed(
        ready.code === 1
          ? svc.health === undefined
            ? "it did not stay up"
            : "it did not become healthy in time"
          : reason(ready),
      );
    }
    notes.push(`started ${svc.name} (${svc.image}) as the CI does`);
  }
  return { ok: true, names: [...started], notes, stop };
}
