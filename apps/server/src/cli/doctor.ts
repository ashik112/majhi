import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { type ConfigState, collapseHome, HostStatusSchema } from "@majhi/shared";
import { loadConfig } from "../config/load.ts";
import type { ServerEnv } from "../env.ts";
import { errorCode, errorMessage, exitCode } from "../errors.ts";
import { isDirectory } from "../fs.ts";

const run = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  /** One line. */
  detail: string;
}

const GB = 1_000_000_000;
const DISK_WARN_BYTES = 5 * GB;
const DISK_FAIL_BYTES = 1 * GB;
const TOOL_TIMEOUT_MS = 5_000;
const HOST_STATUS_TIMEOUT_MS = 3_000;

/** Checks that majhi can run here: config, config folder, git, mounts, SSH agent, disk space, host helper. */
export async function runDoctor(env: ServerEnv): Promise<Check[]> {
  const { state } = await loadConfig(env);
  const groups = await Promise.all([
    [checkConfig(state, env.hostHome)],
    checkMajhiHome(env.majhiHome, env.hostHome).then((c) => [c]),
    checkGit().then((c) => [c]),
    checkRoots(state, env.hostHome),
    checkSshAgent().then((c) => [c]),
    checkDisk(state, env.hostHome).then((c) => [c]),
    checkHostHelper(env.port).then((c) => [c]),
  ]);
  return groups.flat();
}

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const rows = checks.map((c) => `${c.status.toUpperCase()}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary =
    failed + warned === 0
      ? "All checks passed."
      : `${failed} failed, ${warned} ${warned === 1 ? "warning" : "warnings"}.`;
  return `${rows.join("\n")}\n\n${summary}\n`;
}

function checkConfig(state: ConfigState, home: string): Check {
  const file = collapseHome(state.file, home);
  switch (state.status) {
    case "loaded":
      return { name: "Config", status: "pass", detail: `Loaded ${file}` };
    case "first-run":
      return {
        name: "Config",
        status: "warn",
        detail: `No ${file} yet. Open majhi and pick workspace roots.`,
      };
    case "invalid": {
      const more = state.errors.length > 1 ? ` (and ${state.errors.length - 1} more)` : "";
      return { name: "Config", status: "fail", detail: `${file}: ${state.errors[0]}${more}` };
    }
  }
}

async function checkMajhiHome(dir: string, home: string): Promise<Check> {
  const name = "Config folder";
  const shown = collapseHome(dir, home);
  try {
    if (!(await stat(dir)).isDirectory()) return { name, status: "fail", detail: `${shown} is not a folder` };
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return {
        name,
        status: "warn",
        detail: `${shown} does not exist yet. majhi creates it on the first save.`,
      };
    }
    return { name, status: "fail", detail: `${shown}: ${errorMessage(err)}` };
  }
  try {
    await access(dir, constants.W_OK);
    return { name, status: "pass", detail: `${shown} is writable` };
  } catch {
    return { name, status: "fail", detail: `${shown} is not writable` };
  }
}

async function checkGit(): Promise<Check> {
  try {
    const { stdout } = await run("git", ["--version"], { timeout: TOOL_TIMEOUT_MS });
    return { name: "Git", status: "pass", detail: stdout.trim() };
  } catch (err) {
    const detail = errorCode(err) === "ENOENT" ? "git is not installed" : errorMessage(err);
    return { name: "Git", status: "fail", detail };
  }
}

async function checkRoots(state: ConfigState, home: string): Promise<Check[]> {
  if (state.status !== "loaded") {
    return [{ name: "Workspace roots", status: "warn", detail: "None to check until majhi.yaml loads" }];
  }
  return Promise.all(
    state.config.workspaces.map(async (root): Promise<Check> => {
      const shown = collapseHome(root, home);
      return (await isDirectory(root))
        ? { name: "Workspace root", status: "pass", detail: `${shown} is mounted` }
        : { name: "Workspace root", status: "fail", detail: `${shown} is not visible. Run \`make up\`.` };
    }),
  );
}

async function checkSshAgent(): Promise<Check> {
  const name = "SSH agent";
  const socket = process.env.SSH_AUTH_SOCK;
  if (socket === undefined || socket === "") {
    return { name, status: "fail", detail: "SSH_AUTH_SOCK is not set, so git over SSH cannot use your keys" };
  }
  try {
    const { stdout } = await run("ssh-add", ["-l"], { timeout: TOOL_TIMEOUT_MS });
    const keys = stdout.trim().split("\n").filter(Boolean).length;
    return { name, status: "pass", detail: `Reachable, ${keys} ${keys === 1 ? "key" : "keys"} loaded` };
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return { name, status: "warn", detail: "ssh-add is not installed, so the agent was not checked" };
    }
    // Exit 1 means the agent answered but holds no keys yet.
    if (exitCode(err) === 1) {
      return { name, status: "pass", detail: "Reachable, no keys loaded yet" };
    }
    return { name, status: "fail", detail: `Cannot reach the agent at ${socket}` };
  }
}

async function checkDisk(state: ConfigState, home: string): Promise<Check> {
  const name = "Disk space";
  if (state.status !== "loaded") {
    return { name, status: "warn", detail: "Skipped until majhi.yaml loads and names a tasks folder" };
  }
  const target = state.config.tasksDir;
  // The tasks folder may not exist yet. Measure the disk it will live on.
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const fs = await statfs(probe);
    const free = fs.bavail * fs.bsize;
    const detail = `${(free / GB).toFixed(1)} GB free for ${collapseHome(target, home)}`;
    return { name, status: diskStatus(free), detail };
  } catch (err) {
    return { name, status: "fail", detail: `Cannot measure ${probe}: ${errorMessage(err)}` };
  }
}

/** Warn under 5 GB, fail under 1 GB. */
function diskStatus(freeBytes: number): CheckStatus {
  if (freeBytes < DISK_FAIL_BYTES) return "fail";
  if (freeBytes < DISK_WARN_BYTES) return "warn";
  return "pass";
}

/** Asks the running server, on its own port, whether the host helper is connected. */
async function checkHostHelper(port: number): Promise<Check> {
  const name = "Host helper";
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cmd/host.status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(HOST_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { name, status: "warn", detail: `majhi answered ${res.status} to host.status` };
    body = await res.json();
  } catch {
    return { name, status: "warn", detail: "majhi is not running, so the host helper was not checked" };
  }
  const status = HostStatusSchema.safeParse(body);
  if (!status.success) return { name, status: "warn", detail: "majhi sent an invalid host.status answer" };
  if (!status.data.connected) {
    return {
      name,
      status: "warn",
      detail: "Not connected, so folder browsing and automatic remounts are off. Run `make up` on the host.",
    };
  }
  const version = status.data.info === undefined ? "" : ` (version ${status.data.info.version})`;
  const remounts =
    status.data.info?.canRemount === true
      ? "automatic remounts are on"
      : "it cannot run Docker, so remounts need `make up`";
  return { name, status: "pass", detail: `Connected${version}, ${remounts}` };
}
