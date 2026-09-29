import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import {
  type ConfigState,
  collapseHome,
  type HostStatus,
  HostStatusSchema,
  type SshStatus,
  sshUnlockCommand,
} from "@majhi/shared";
import { loadConfig } from "../config/load.ts";
import type { ServerEnv } from "../env.ts";
import { errorCode, errorMessage, exitCode } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import { createServices, type Services } from "../services.ts";
import { probeHosts, sshTargets } from "../ssh/hosts.ts";

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
export async function runDoctor(env: ServerEnv, services: Services = createServices(env)): Promise<Check[]> {
  const { state, projectPaths } = await loadConfig(env);
  const host = fetchHostStatus(env.port);
  const groups = await Promise.all([
    [checkConfig(state, env.hostHome)],
    checkMajhiHome(env.majhiHome, env.hostHome).then((c) => [c]),
    checkGit().then((c) => [c]),
    checkRoots(state, env.hostHome),
    host.then((h) => checkSshAgent(h.status?.info?.ssh)).then((c) => [c]),
    checkSshHosts(projectPaths),
    checkDisk(state, env.hostHome).then((c) => [c]),
    host.then(checkHostHelper).then((c) => [c]),
    checkSecrets(services),
    checkTools(env, services),
    checkAccounts(services),
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

/** `ssh` is what the host helper last reported. It knows which keys need a passphrase. */
export async function checkSshAgent(ssh: SshStatus | undefined): Promise<Check> {
  const name = "SSH agent";
  const socket = process.env.SSH_AUTH_SOCK;
  if (socket === undefined || socket === "") {
    return { name, status: "fail", detail: "SSH_AUTH_SOCK is not set, so git over SSH cannot use your keys" };
  }
  let keys: number;
  try {
    const { stdout } = await run("ssh-add", ["-l"], { timeout: TOOL_TIMEOUT_MS });
    keys = stdout.trim().split("\n").filter(Boolean).length;
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return { name, status: "warn", detail: "ssh-add is not installed, so the agent was not checked" };
    }
    // Exit 1 means the agent answered but holds no keys yet.
    if (exitCode(err) !== 1) return { name, status: "fail", detail: `Cannot reach the agent at ${socket}` };
    keys = 0;
  }
  return sshVerdict(name, keys, ssh);
}

export function sshVerdict(name: string, keys: number, ssh: SshStatus | undefined): Check {
  const held = `${keys} ${keys === 1 ? "key" : "keys"} loaded`;
  const needs = ssh?.needsPassphrase ?? [];
  if (needs.length > 0) {
    const commands = needs.map(sshUnlockCommand).join(" ; ");
    return {
      name,
      status: "warn",
      detail: `Reachable, ${held}. A key needs its passphrase once: run ${commands}, or unlock it on the Repos screen.`,
    };
  }
  if (keys === 0) {
    const why = ssh === undefined ? "the host helper has not loaded any" : "no key file was found to load";
    return { name, status: "warn", detail: `Reachable, no keys loaded (${why}), so git over SSH will fail` };
  }
  return { name, status: "pass", detail: `Reachable, ${held}` };
}

/** `ssh -T` against each git host the registered projects use. Prints states only, never key material. */
async function checkSshHosts(projectPaths: readonly string[]): Promise<Check[]> {
  const results = await probeHosts(await sshTargets(projectPaths));
  return results.map((r): Check => {
    const name = `SSH host ${r.host}`;
    return { name, status: r.state === "reachable" ? "pass" : "warn", detail: `${r.state}: ${r.detail}` };
  });
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

async function checkSecrets(services: Services): Promise<Check[]> {
  const name = "Secrets key";
  return (await services.secrets.available())
    ? [{ name, status: "pass", detail: "Found, so API-key accounts work" }]
    : [{ name, status: "warn", detail: "No key file. API-key accounts need it: run `make up`." }];
}

/** Each agent CLI's version. A missing CLI fails when an account uses it, and warns otherwise. */
async function checkTools(env: ServerEnv, services: Services): Promise<Check[]> {
  const accounts = await services.accounts.list().catch(() => []);
  return Promise.all(
    services.runtime.toolInfos().map(async (tool): Promise<Check> => {
      const name = `${tool.name} CLI`;
      try {
        return { name, status: "pass", detail: await services.runtime.cliVersion(tool.id, env.runtime) };
      } catch (err) {
        const used = accounts.some((a) => a.tool === tool.id);
        return { name, status: used ? "fail" : "warn", detail: firstLine(errorMessage(err)) };
      }
    }),
  );
}

/** Each account's sign-in, from a full health check. It spends no tokens. */
async function checkAccounts(services: Services): Promise<Check[]> {
  let accounts: Awaited<ReturnType<Services["accounts"]["list"]>>;
  try {
    accounts = await services.accounts.list();
  } catch {
    return [];
  }
  return Promise.all(
    accounts.map(async (account): Promise<Check> => {
      const name = `Account ${account.id}`;
      try {
        const { health, account: view } = await services.accounts.health(account.id, true);
        if (health.ok) {
          const who = view.signedInAs === undefined ? "" : ` as ${view.signedInAs}`;
          return { name, status: "pass", detail: `Signed in${who}` };
        }
        const failed = health.steps.find((s) => !s.ok);
        const detail = failed === undefined ? "Check failed" : `${failed.name}: ${failed.detail}`;
        return { name, status: view.status === "needs-login" ? "warn" : "fail", detail };
      } catch (err) {
        return { name, status: "fail", detail: firstLine(errorMessage(err)) };
      }
    }),
  );
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

type HostFetch = { status: HostStatus; problem?: undefined } | { status?: undefined; problem: string };

/** Asks the running server, on its own port, what the host helper reports. */
async function fetchHostStatus(port: number): Promise<HostFetch> {
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cmd/host.status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(HOST_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { problem: `majhi answered ${res.status} to host.status` };
    body = await res.json();
  } catch {
    return { problem: "majhi is not running, so the host helper was not checked" };
  }
  const status = HostStatusSchema.safeParse(body);
  if (!status.success) return { problem: "majhi sent an invalid host.status answer" };
  return { status: status.data };
}

function checkHostHelper(host: HostFetch): Check {
  const name = "Host helper";
  if (host.status === undefined) return { name, status: "warn", detail: host.problem };
  const { status } = host;
  if (!status.connected) {
    return {
      name,
      status: "warn",
      detail: "Not connected, so folder browsing and automatic remounts are off. Run `make up` on the host.",
    };
  }
  const version = status.info === undefined ? "" : ` (version ${status.info.version})`;
  const remounts =
    status.info?.canRemount === true
      ? "automatic remounts are on"
      : "it cannot run Docker, so remounts need `make up`";
  return { name, status: "pass", detail: `Connected${version}, ${remounts}` };
}
