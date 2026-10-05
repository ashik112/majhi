import { execFile } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, stat, statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { BackupList } from "@majhi/shared";
import {
  type AccountView,
  type ConfigState,
  type ConnectionView,
  collapseHome,
  dockerRuntimeName,
  FAILURE_LINE,
  type HostOs,
  type HostStatus,
  hostOsOf,
  keyringName,
  type SshHostCheck,
  type SshStatus,
  sshUnlockCommand,
  TRANSIENT_FAILURES,
} from "@majhi/shared";
import type { ServerEnv } from "../env.ts";
import { errorCode, errorMessage, exitCode } from "../errors.ts";
import { isDirectory } from "../fs.ts";
import { machineLine, machineWarnings, upperFirst } from "../machine/busy.ts";
import { checkRunnerIsolation, checkSerena } from "../runner/check.ts";
import { SERENA_COMMAND } from "../runs/serena.ts";
import type { KeyExportRecord } from "../secrets/backup.ts";
import type { SecretsKeyState } from "../secrets/store.ts";
import type { Services } from "../services.ts";
import { sizeText } from "../tasks/folder-sweep.ts";

const run = promisify(execFile);

export type CheckStatus = "pass" | "warn" | "fail";
export type CheckGroup = "majhi" | "host" | "ssh" | "accounts" | "connections" | "disk";

export interface Check {
  /** Stable, like `root:/Users/a/Work`. `health.fix` takes it back. */
  id: string;
  group: CheckGroup;
  /** What the check is about, like `Workspace root ~/Work`. */
  name: string;
  status: CheckStatus;
  /** One line. When the check failed and majhi cannot fix it, it says what the owner must do. */
  detail: string;
  /** A fix majhi can run itself. */
  fix?: { label: string };
  /** The workspace the thing checked belongs to, when it belongs to one. */
  org?: string;
  /** When the check last ran, for rows that keep their own result (accounts, connections). */
  checkedAt?: string;
}

const GB = 1_000_000_000;
const DISK_WARN_BYTES = 5 * GB;
const DISK_FAIL_BYTES = 1 * GB;
const TOOL_TIMEOUT_MS = 5_000;
const TOOL_CACHE_MS = 10 * 60_000;

export type HostSource =
  | { status: HostStatus; problem?: undefined }
  | { status?: undefined; problem: string };

/** Remembers each CLI's version for a while, so a health check every few minutes does not start every CLI. */
export type ToolCache = Map<string, { at: number; check: Check }>;

export interface CheckContext {
  env: ServerEnv;
  services: Services;
  config: { state: ConfigState; projectPaths: readonly string[] };
  host: HostSource;
  /** What the git host probes found. Called once. */
  sshHosts: () => Promise<readonly SshHostCheck[]>;
  /**
   * `cached` reads each account's last health check. `probe` runs a full check of each account,
   * which is what `make doctor` does. Neither spends tokens.
   */
  accounts: "cached" | "probe";
  toolCache?: ToolCache;
  now?: () => number;
}

/** Everything `make doctor` and `health.run` check. Each check never throws. */
export async function collectChecks(ctx: CheckContext): Promise<Check[]> {
  const { state } = ctx.config;
  const home = ctx.env.hostHome;
  const groups = await Promise.all([
    [checkConfig(state, home)],
    checkMajhiHome(ctx.env.majhiHome, home).then((c) => [c]),
    checkGit().then((c) => [c]),
    checkRoots(state, home, ctx.host),
    [checkHostHelper(ctx.host)],
    checkSshAgent(ctx.host.status?.info?.ssh, ctx.host, ctx.env.sshAgentOff).then((c) => [c]),
    checkSshHosts(ctx.sshHosts, ctx.host, ctx.env.sshAgentOff),
    checkTasksDir(state, home),
    checkDisk(state, home).then((c) => [c]),
    [checkTaskFolders(ctx.services)],
    [checkMachine(ctx.services)],
    checkSecrets(ctx.services),
    checkKeyBackup(ctx),
    checkBackups(ctx),
    checkTools(ctx),
    checkRunner(ctx),
    checkSerenaTool(ctx),
    checkAccounts(ctx),
    checkConnections(ctx),
  ]);
  return groups.flat();
}

/** Tests that run at once: each may start a runner container. */
const CONNECTION_TESTS_AT_ONCE = 3;

/**
 * Each connection's check (5.14). `doctor` tests every connection. The Health page and the sidebar
 * read the last result; the page's "Run health check" (`health.checkAll`) makes it fresh first.
 */
async function checkConnections(ctx: CheckContext): Promise<Check[]> {
  const views = await ctx.services.connections.list().catch(() => []);
  if (ctx.accounts === "probe") {
    for (let i = 0; i < views.length; i += CONNECTION_TESTS_AT_ONCE) {
      const batch = views.slice(i, i + CONNECTION_TESTS_AT_ONCE);
      await Promise.all(
        batch.map((view) => ctx.services.connectionTests.test(view.id).catch(() => undefined)),
      );
    }
    const fresh = await ctx.services.connections.list().catch(() => views);
    return fresh.map(connectionCheck);
  }
  return views.map(connectionCheck);
}

/** One row for a connection, from its last check. A failure the owner cannot fix leaves out Reconnect. */
export function connectionCheck(view: ConnectionView): Check {
  const base = {
    id: `connection:${view.id}`,
    group: "connections" as const,
    name: `${view.name} (${view.org})`,
    org: view.org,
  };
  if (view.problems.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `Not set up: ${view.problems.join(". ")}.`,
      fix: { label: "Open settings" },
    };
  }
  const result = view.lastTest;
  if (result !== undefined) {
    if (!result.ok) {
      const transient = result.failure !== undefined && TRANSIENT_FAILURES.has(result.failure.reason);
      return {
        ...base,
        status: "fail",
        detail: result.detail,
        checkedAt: result.at,
        ...(transient ? {} : { fix: { label: "Reconnect" } }),
      };
    }
    const warning = result.warnings[0];
    return warning === undefined
      ? { ...base, status: "pass", detail: result.detail, checkedAt: result.at }
      : { ...base, status: "warn", detail: warning, checkedAt: result.at };
  }
  const h = view.health;
  if (h?.state === "connected") {
    return { ...base, status: "pass", detail: h.checked[0] ?? "Connected", checkedAt: h.verifiedAt };
  }
  if (h?.state === "failed" || h?.state === "needs-attention") {
    return {
      ...base,
      status: "fail",
      detail: `${FAILURE_LINE[h.reason]}. ${h.fix}`,
      checkedAt: h.at,
      ...(TRANSIENT_FAILURES.has(h.reason) ? {} : { fix: { label: "Reconnect" } }),
    };
  }
  return { ...base, status: "warn", detail: "Not checked yet." };
}

/** True when the helper is connected and can run Docker, so fixes that need it are on offer. */
function helperCanRemount(host: HostSource): boolean {
  return host.status?.connected === true && host.status.info?.canRemount === true;
}

function helperConnected(host: HostSource): boolean {
  return host.status?.connected === true;
}

const MAKE_UP = "Run `make up` in the majhi folder once.";

export function checkConfig(state: ConfigState, home: string): Check {
  const file = collapseHome(state.file, home);
  const base = { id: "config", group: "majhi", name: "Config" } as const;
  switch (state.status) {
    case "loaded":
      return { ...base, status: "pass", detail: `Loaded ${file}` };
    case "first-run":
      return { ...base, status: "warn", detail: `No ${file} yet. Open majhi and pick workspace roots.` };
    case "invalid": {
      const more = state.errors.length > 1 ? ` (and ${state.errors.length - 1} more)` : "";
      return {
        ...base,
        status: "fail",
        detail: `${file}: ${state.errors[0]}${more}. Fix that in the file, then run the check again.`,
      };
    }
  }
}

async function checkMajhiHome(dir: string, home: string): Promise<Check> {
  const base = { id: "config-folder", group: "majhi", name: "Config folder" } as const;
  const shown = collapseHome(dir, home);
  try {
    if (!(await stat(dir)).isDirectory()) {
      return {
        ...base,
        status: "fail",
        detail: `${shown} is a file. Move it away so majhi can make the folder.`,
      };
    }
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return {
        ...base,
        status: "warn",
        detail: `${shown} does not exist yet. majhi creates it on the first save.`,
        fix: { label: "Create folder" },
      };
    }
    return { ...base, status: "fail", detail: `${shown}: ${errorMessage(err)}` };
  }
  try {
    await access(dir, constants.W_OK);
    return { ...base, status: "pass", detail: `${shown} is writable` };
  } catch {
    return {
      ...base,
      status: "fail",
      detail: `${shown} is not writable. Give your user write access to it, then run the check again.`,
    };
  }
}

async function checkGit(): Promise<Check> {
  const base = { id: "git", group: "majhi", name: "Git" } as const;
  try {
    const { stdout } = await run("git", ["--version"], { timeout: TOOL_TIMEOUT_MS });
    return { ...base, status: "pass", detail: stdout.trim() };
  } catch (err) {
    const detail =
      errorCode(err) === "ENOENT"
        ? "git is missing from the majhi image. Run `make up` to rebuild it."
        : errorMessage(err);
    return { ...base, status: "fail", detail };
  }
}

async function checkRoots(state: ConfigState, home: string, host: HostSource): Promise<Check[]> {
  if (state.status !== "loaded") {
    return [
      {
        id: "roots",
        group: "host",
        name: "Workspace roots",
        status: "warn",
        detail: "None to check until majhi.yaml loads",
      },
    ];
  }
  return Promise.all(
    state.config.workspaces.map(async (root): Promise<Check> => {
      const shown = collapseHome(root, home);
      const base = { id: `root:${root}`, group: "host", name: `Workspace root ${shown}` } as const;
      if (await isDirectory(root)) return { ...base, status: "pass", detail: `${shown} is mounted` };
      return helperCanRemount(host)
        ? {
            ...base,
            status: "fail",
            detail: `${shown} is not visible to majhi yet. majhi restarts itself to mount it.`,
            fix: { label: "Mount it" },
          }
        : { ...base, status: "fail", detail: `${shown} is not visible to majhi. ${MAKE_UP}` };
    }),
  );
}

export function checkHostHelper(host: HostSource): Check {
  const base = { id: "host-helper", group: "host", name: "Host helper" } as const;
  if (host.status === undefined) return { ...base, status: "warn", detail: host.problem };
  const { status } = host;
  if (!status.connected) {
    return {
      ...base,
      status: "warn",
      detail: `Not connected, so folder browsing, remounts and one-click updates are off. ${MAKE_UP}`,
    };
  }
  const version = status.info === undefined ? "" : ` (version ${status.info.version})`;
  if (status.info?.canRemount !== true) {
    return {
      ...base,
      status: "warn",
      detail: `Connected${version}, but it cannot run Docker, so remounts and updates need \`make up\`. If Docker is installed now, restart the helper.`,
      fix: { label: "Restart helper" },
    };
  }
  const runtime =
    status.info.dockerRuntime === undefined ? "" : ` with ${dockerRuntimeName(status.info.dockerRuntime)}`;
  return { ...base, status: "pass", detail: `Connected${version}, automatic remounts are on${runtime}` };
}

/**
 * `ssh` is what the host helper last reported. It knows which keys need a passphrase. `agentOff`:
 * the owner turned the agent off on purpose, which is no fault. The git host rows show what it breaks.
 */
export async function checkSshAgent(
  ssh: SshStatus | undefined,
  host?: HostSource,
  agentOff = false,
): Promise<Check> {
  const base = { id: "ssh-agent", group: "ssh", name: "SSH agent" } as const;
  const name = base.name;
  if (agentOff) {
    return {
      ...base,
      status: "pass",
      detail:
        "Turned off with MAJHI_SSH_AGENT=off, so git over SSH cannot use your keys. Run `make up` without that setting to turn it on.",
    };
  }
  const socket = process.env.SSH_AUTH_SOCK;
  const reload = host !== undefined && helperConnected(host) ? { fix: { label: "Reload SSH keys" } } : {};
  if (socket === undefined || socket === "") {
    return {
      ...base,
      status: "fail",
      detail: `SSH_AUTH_SOCK is not set, so git over SSH cannot use your keys. ${MAKE_UP}`,
    };
  }
  let keys: number;
  try {
    const { stdout } = await run("ssh-add", ["-l"], { timeout: TOOL_TIMEOUT_MS });
    keys = stdout.trim().split("\n").filter(Boolean).length;
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      return {
        ...base,
        status: "warn",
        detail: "ssh-add is missing from the majhi image, so the agent was not checked",
      };
    }
    // Exit 1 means the agent answered but holds no keys yet.
    if (exitCode(err) !== 1) {
      return {
        ...base,
        status: "fail",
        detail: `Cannot reach the agent at ${socket}. ${MAKE_UP}`,
        ...reload,
      };
    }
    keys = 0;
  }
  const verdict = sshVerdict(name, keys, ssh, hostOsOf(host?.status?.info));
  const needsPassphrase = (ssh?.needsPassphrase.length ?? 0) > 0;
  return { ...base, ...verdict, ...(verdict.status !== "pass" && !needsPassphrase ? reload : {}) };
}

/** `os` picks the unlock command: the helper's OS, undefined when no helper said. */
export function sshVerdict(
  name: string,
  keys: number,
  ssh: SshStatus | undefined,
  os?: HostOs,
): { name: string; status: CheckStatus; detail: string } {
  const held = `${keys} ${keys === 1 ? "key" : "keys"} loaded`;
  const needs = ssh?.needsPassphrase ?? [];
  if (needs.length > 0) {
    const commands = needs.map((key) => sshUnlockCommand(key, os)).join(" ; ");
    return {
      name,
      status: "warn",
      detail: `Reachable, ${held}. A key needs its passphrase once: unlock it on the Projects screen, or run ${commands}.`,
    };
  }
  if (keys === 0) {
    const why = ssh === undefined ? "the host helper has not loaded any" : "no key file was found to load";
    return { name, status: "warn", detail: `Reachable, no keys loaded (${why}), so git over SSH will fail` };
  }
  return { name, status: "pass", detail: `Reachable, ${held}` };
}

/**
 * One row per git host the registered projects use. Prints states only, never key material. With the
 * agent off, reloading keys cannot help, so it is not offered.
 */
async function checkSshHosts(
  probe: CheckContext["sshHosts"],
  host: HostSource,
  agentOff: boolean,
): Promise<Check[]> {
  const results = await probe().catch(() => []);
  return results.map((r): Check => {
    const check: Check = {
      id: `ssh-host:${r.host}`,
      group: "ssh",
      name: `SSH host ${r.host}`,
      status: r.state === "reachable" ? "pass" : "warn",
      detail: `${r.state}: ${r.detail}`,
    };
    const reload = r.state === "auth-failed" && !agentOff && helperConnected(host);
    if (reload) check.fix = { label: "Reload SSH keys" };
    return check;
  });
}

async function checkTasksDir(state: ConfigState, home: string): Promise<Check[]> {
  if (state.status !== "loaded") return [];
  const dir = state.config.tasksDir;
  const shown = collapseHome(dir, home);
  const base = { id: "tasks-dir", group: "majhi", name: "Tasks folder" } as const;
  if (await isDirectory(dir)) return [{ ...base, status: "pass", detail: `${shown} exists` }];
  return [
    {
      ...base,
      status: "warn",
      detail: `${shown} does not exist yet. majhi creates it with your first task.`,
      fix: { label: "Create folder" },
    },
  ];
}

async function checkDisk(state: ConfigState, home: string): Promise<Check> {
  const base = { id: "disk", group: "disk", name: "Disk space" } as const;
  if (state.status !== "loaded") {
    return { ...base, status: "warn", detail: "Skipped until majhi.yaml loads and names a tasks folder" };
  }
  const target = state.config.tasksDir;
  // The tasks folder may not exist yet. Measure the disk it will live on.
  let probe = target;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  try {
    const fs = await statfs(probe);
    const free = fs.bavail * fs.bsize;
    const detail = `${(free / GB).toFixed(1)} GB free for ${collapseHome(target, home)}`;
    const status = diskStatus(free);
    return {
      ...base,
      status,
      detail: status === "pass" ? detail : `${detail}. Delete finished tasks or free space on that disk.`,
    };
  } catch (err) {
    return { ...base, status: "fail", detail: `Cannot measure ${probe}: ${errorMessage(err)}` };
  }
}

/** Load, memory and disk of the owner's computer, from the machine sensor (not the container's view). */
function checkMachine(services: Services): Check {
  const base = { id: "machine", group: "host", name: "Machine load" } as const;
  const reading = services.machine.get();
  if (reading?.host === undefined) {
    return { ...base, status: "pass", detail: "Not read yet. It needs the host helper." };
  }
  const warnings = machineWarnings(reading.host, services.machine.idleLowMs());
  const detail = machineLine(reading);
  if (warnings.length === 0) return { ...base, status: "pass", detail };
  return { ...base, status: "warn", detail: `${upperFirst(warnings.join(", "))}. ${detail}` };
}

/** Task folders above this size are a warning, with a fix that frees what done tasks can rebuild. */
export const TASK_FOLDERS_WARN_BYTES = 20 * GB;

function checkTaskFolders(services: Services): Check {
  const base = { id: "task-folders", group: "disk", name: "Task folders" } as const;
  const m = services.folderSweep.snapshot();
  if (m === undefined) return { ...base, status: "pass", detail: "Measuring the task folders..." };
  const detail = `${sizeText(m.rootBytes)} in task folders, ${sizeText(m.rebuildableBytes)} of it rebuildable in ${m.tasks} done ${m.tasks === 1 ? "task" : "tasks"}`;
  if (m.rootBytes <= TASK_FOLDERS_WARN_BYTES) return { ...base, status: "pass", detail };
  return {
    ...base,
    status: "warn",
    detail: m.rebuildableBytes > 0 ? detail : `${detail}. Nothing in done tasks can be freed.`,
    ...(m.rebuildableBytes > 0 ? { fix: { label: "Free space now" } } : {}),
  };
}

/** Warn under 5 GB, fail under 1 GB. */
export function diskStatus(freeBytes: number): CheckStatus {
  if (freeBytes < DISK_FAIL_BYTES) return "fail";
  if (freeBytes < DISK_WARN_BYTES) return "warn";
  return "pass";
}

const SECRETS_KEY_CHECK = { id: "secrets-key", group: "majhi", name: "Secrets key" } as const;

async function checkSecrets(services: Services): Promise<Check[]> {
  try {
    return [secretsKeyCheck(await services.secrets.keyState())];
  } catch (err) {
    const detail = `Cannot read the key file or secrets.age: ${errorMessage(err)}`;
    return [{ ...SECRETS_KEY_CHECK, status: "fail", detail }];
  }
}

/** Fails when saved API keys cannot be read. Without a working key, it offers the export's restore. */
function secretsKeyCheck(state: SecretsKeyState): Check {
  const base = SECRETS_KEY_CHECK;
  const restore = { fix: { label: "Restore from export" } };
  switch (state) {
    case "ok":
      return { ...base, status: "pass", detail: "Found, so API-key accounts work" };
    case "missing":
      return {
        ...base,
        status: "warn",
        detail: `No key file, so API keys cannot be saved. ${MAKE_UP} It creates the key. Or restore the key from its export.`,
        ...restore,
      };
    case "lost":
      return {
        ...base,
        status: "fail",
        detail:
          "No key file, so the saved API keys in secrets.age cannot be read. Restore the key from its export.",
        ...restore,
      };
    case "wrong":
      return {
        ...base,
        status: "fail",
        detail:
          "The key file does not open secrets.age, so the saved API keys cannot be read. Restore the key from its export.",
        ...restore,
      };
  }
}

/**
 * The two backups of the secrets key: the copy the host helper keeps in the Keychain or keyring, and
 * the passphrase-protected export to keep off this computer. Each warns until it holds the key majhi
 * uses. Nothing to back up while there is no key, or while it does not open secrets.age: the Secrets
 * key check says so, and saving that key would replace a keyring copy that may be the right one.
 */
async function checkKeyBackup(ctx: CheckContext): Promise<Check[]> {
  if ((await ctx.services.secrets.keyState().catch(() => undefined)) !== "ok") return [];
  const fingerprint = await ctx.services.secrets.fingerprint().catch(() => undefined);
  if (fingerprint === undefined) return [];
  const last = await ctx.services.keyExports.last().catch(() => undefined);
  return [keychainCheck(fingerprint, ctx.host), exportCheck(fingerprint, last)];
}

/**
 * The helper's copy in the macOS Keychain or a Linux and WSL2 keyring. The id keeps the Keychain's
 * name: `health.fix` takes it back.
 */
export function keychainCheck(fingerprint: string, host: HostSource): Check {
  const info = host.status?.info;
  const os = hostOsOf(info);
  const where = keyringName(os);
  const base = { id: "secrets-key-keychain", group: "majhi", name: `Secrets key in ${where}` } as const;
  if (!helperConnected(host)) {
    return { ...base, status: "warn", detail: "Not checked: the host helper is not connected." };
  }
  if (info?.keyring?.kind === "none") {
    // A locked keyring may still hold a copy from before, so "may".
    return {
      ...base,
      status: "warn",
      detail: `${info.keyring.reason} The export may be the only other copy of the key.`,
    };
  }
  const saved = info?.secretsKey;
  const save = { fix: { label: `Save to ${where}` } };
  if (saved?.error !== undefined) return { ...base, status: "warn", detail: saved.error, ...save };
  if (saved?.saved === undefined) {
    return {
      ...base,
      status: "warn",
      detail: `No copy in ${where} yet. Without one, a lost key file makes every saved API key unreadable.`,
      ...save,
    };
  }
  if (saved.saved !== fingerprint) {
    return {
      ...base,
      status: "warn",
      detail: `A different key is in ${where}, maybe from an earlier install. Replace it with the key majhi uses.`,
      fix: { label: "Replace copy" },
    };
  }
  const place = os === "macos" ? "the login Keychain" : where;
  return { ...base, status: "pass", detail: `A copy is in ${place} as "majhi secrets key"` };
}

export function exportCheck(fingerprint: string, last: KeyExportRecord | undefined): Check {
  const base = { id: "secrets-key-export", group: "majhi", name: "Secrets key export" } as const;
  const exportFix = { fix: { label: "Export key" } };
  if (last === undefined) {
    return {
      ...base,
      status: "warn",
      detail:
        "No export yet. Export the key with a passphrase and keep the file off this computer, in case the computer is lost.",
      ...exportFix,
    };
  }
  if (last.fingerprint !== fingerprint) {
    return {
      ...base,
      status: "warn",
      detail: "The last export holds an older key. Export the current one.",
      ...exportFix,
    };
  }
  return {
    ...base,
    status: "pass",
    detail: `Exported on ${last.exportedAt.slice(0, 10)}. Keep the file off this computer.`,
  };
}

/** Each agent CLI's version. A missing CLI fails when an account uses it, and warns otherwise. */
async function checkTools(ctx: CheckContext): Promise<Check[]> {
  const { env, services } = ctx;
  const now = ctx.now ?? Date.now;
  const accounts = await services.accounts.list().catch(() => []);
  return Promise.all(
    services.runtime.toolInfos().map(async (tool): Promise<Check> => {
      const cached = ctx.toolCache?.get(tool.id);
      if (cached !== undefined && now() - cached.at < TOOL_CACHE_MS) return cached.check;
      const base = { id: `tool:${tool.id}`, group: "majhi", name: `${tool.name} CLI` } as const;
      let check: Check;
      try {
        check = { ...base, status: "pass", detail: await services.runtime.cliVersion(tool.id, env.runtime) };
      } catch (err) {
        const used = accounts.some((a) => a.tool === tool.id);
        check = {
          ...base,
          status: used ? "fail" : "warn",
          detail: `${firstLine(errorMessage(err))}. Update majhi to reinstall it.`,
        };
      }
      ctx.toolCache?.set(tool.id, { at: now(), check });
      return check;
    }),
  );
}

/**
 * Runner isolation (Phase 2c): a throwaway runner started like every agent run must not see
 * majhi's config, the secrets key or another account. Only when agents run in runners; the
 * result is kept for a while, as starting a container is not free.
 */
async function checkRunner(ctx: CheckContext): Promise<Check[]> {
  const runner = ctx.services.runner;
  if (runner === undefined) return [];
  const now = ctx.now ?? Date.now;
  const cached = ctx.toolCache?.get("runner");
  if (cached !== undefined && now() - cached.at < TOOL_CACHE_MS) return [cached.check];
  const verdict = await checkRunnerIsolation({
    runner,
    majhiHome: ctx.env.majhiHome,
    hostHome: ctx.env.hostHome,
    secretsKeyFile: ctx.env.secretsKeyFile,
  });
  const check: Check = {
    id: "runner",
    group: "majhi",
    name: "Agent runner",
    status: verdict.ok ? "pass" : "fail",
    detail: verdict.detail,
    ...(verdict.rebuild ? { fix: { label: "Rebuild majhi" } } : {}),
  };
  ctx.toolCache?.set("runner", { at: now(), check });
  return [check];
}

/**
 * Serena in the runner (5.9 item 6): agents that edit code get it as a tool. A warning, not a
 * failure: without it they work with whole files. Only when agents run in runners, and kept for a
 * while like the isolation check.
 */
async function checkSerenaTool(ctx: CheckContext): Promise<Check[]> {
  const runner = ctx.services.runner;
  if (runner === undefined) return [];
  const now = ctx.now ?? Date.now;
  const cached = ctx.toolCache?.get("serena");
  if (cached !== undefined && now() - cached.at < TOOL_CACHE_MS) return [cached.check];
  const verdict = await checkSerena({ runner, majhiHome: ctx.env.majhiHome, command: SERENA_COMMAND });
  const check: Check = {
    id: "serena",
    group: "majhi",
    name: "Serena",
    status: verdict.ok ? "pass" : "warn",
    detail: verdict.detail,
    ...(verdict.rebuild ? { fix: { label: "Rebuild majhi" } } : {}),
  };
  ctx.toolCache?.set("serena", { at: now(), check });
  return [check];
}

/** Each account's sign-in. Spends no tokens. */
async function checkAccounts(ctx: CheckContext): Promise<Check[]> {
  const { services } = ctx;
  let views: AccountView[];
  try {
    views = await services.accounts.list();
  } catch {
    return [];
  }
  return Promise.all(
    views.map(async (view): Promise<Check> => {
      if (ctx.accounts === "cached")
        return accountCheck(view, view.lastHealth?.steps, view.lastHealth?.checkedAt);
      try {
        const { health, account } = await services.accounts.health(view.id, true);
        return accountCheck(account, health.steps, health.checkedAt);
      } catch (err) {
        return {
          id: `account:${view.id}`,
          group: "accounts",
          name: `Account ${view.id}`,
          status: "fail",
          detail: firstLine(errorMessage(err)),
        };
      }
    }),
  );
}

/** One row for an account, from its status and the steps of its last health check. */
export function accountCheck(
  view: Pick<AccountView, "id" | "status" | "signedInAs" | "auth">,
  steps: readonly { name: string; ok: boolean; detail: string }[] | undefined,
  checkedAt?: string,
): Check {
  const base = {
    id: `account:${view.id}`,
    group: "accounts",
    name: `Account ${view.id}`,
    ...(checkedAt === undefined ? {} : { checkedAt }),
  } as const;
  const failed = steps?.find((s) => !s.ok);
  const who = view.signedInAs === undefined ? "" : ` as ${view.signedInAs}`;
  switch (view.status) {
    case "healthy":
    case "running-high":
      return { ...base, status: "pass", detail: `Signed in${who}` };
    case "needs-login":
      return {
        ...base,
        status: "warn",
        detail: "Signed out. Sign in again to use its agents.",
        fix: { label: "Sign in" },
      };
    case "relogin-soon":
      return { ...base, status: "warn", detail: "The sign-in expires soon.", fix: { label: "Sign in" } };
    case "at-limit":
      return { ...base, status: "warn", detail: "At its usage limit. It resets on its own." };
    case "unreachable":
      return {
        ...base,
        status: "fail",
        detail: failed === undefined ? "Not answering" : `${failed.name}: ${failed.detail}`,
      };
    case "unknown":
      return { ...base, status: "warn", detail: "Not checked yet." };
  }
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

/** A newest backup older than this is stale: the daily one is overdue. */
const BACKUP_STALE_MS = 36 * 60 * 60 * 1000;
/** A check older than this is overdue: majhi checks weekly. */
const VERIFY_STALE_MS = 10 * 24 * 60 * 60 * 1000;

async function checkBackups(ctx: CheckContext): Promise<Check[]> {
  const list = await ctx.services.backup.list().catch(() => undefined);
  return list === undefined ? [] : backupChecks(list, (ctx.now ?? Date.now)());
}

function ago(iso: string, now: number): string {
  const hours = Math.max(0, Math.round((now - Date.parse(iso)) / 3_600_000));
  return hours < 1
    ? "under an hour ago"
    : hours < 48
      ? `${hours} h ago`
      : `${Math.round(hours / 24)} days ago`;
}

/** Two checks: is there a recent backup, and did the last test restore work. */
export function backupChecks(list: BackupList, now: number): Check[] {
  const fresh = { id: "backups", group: "majhi", name: "Backups" } as const;
  const verify = { id: "backups-verify", group: "majhi", name: "Backup test restore" } as const;
  const checks: Check[] = [];
  if (list.lastError !== undefined && (list.lastAt === undefined || list.lastError.at > list.lastAt)) {
    checks.push({
      ...fresh,
      status: "fail",
      detail: `The last backup failed: ${list.lastError.detail}`,
      fix: { label: "Back up now" },
    });
  } else if (list.lastAt === undefined) {
    checks.push({
      ...fresh,
      status: "warn",
      detail: "No backup yet. majhi takes the first one soon after it starts.",
      fix: { label: "Back up now" },
    });
  } else if (now - Date.parse(list.lastAt) > BACKUP_STALE_MS) {
    checks.push({
      ...fresh,
      status: "warn",
      detail: `The newest backup is from ${ago(list.lastAt, now)}. One is due every day.`,
      fix: { label: "Back up now" },
    });
  } else {
    checks.push({
      ...fresh,
      status: "pass",
      detail: `Backed up ${ago(list.lastAt, now)}, ${list.backups.length} kept in ${list.destination.path}`,
    });
  }
  if (list.destination.error !== undefined) {
    checks.push({
      id: "backups-folder",
      group: "majhi",
      name: "Backup folder",
      status: "fail",
      detail: list.destination.error,
    });
  }
  if (list.lastAt !== undefined) {
    if (list.lastVerify === undefined) {
      checks.push({
        ...verify,
        status: "warn",
        detail: "Not tested yet. majhi restores the newest backup into a temporary folder every week.",
        fix: { label: "Test now" },
      });
    } else if (!list.lastVerify.ok) {
      checks.push({
        ...verify,
        status: "fail",
        detail: `The test restore failed: ${list.lastVerify.detail}`,
        fix: { label: "Test now" },
      });
    } else if (now - Date.parse(list.lastVerify.at) > VERIFY_STALE_MS) {
      checks.push({
        ...verify,
        status: "warn",
        detail: `Last tested ${ago(list.lastVerify.at, now)}.`,
        fix: { label: "Test now" },
      });
    } else {
      checks.push({
        ...verify,
        status: "pass",
        detail: `Tested ${ago(list.lastVerify.at, now)}: ${list.lastVerify.detail}`,
      });
    }
  }
  return checks;
}
