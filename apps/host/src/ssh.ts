/**
 * Keeps the Mac's SSH agent loaded so majhi's own git can reach remotes over
 * SSH through the forwarded socket (SPEC 4.5). Private keys never leave the
 * Mac. Nothing here ever prompts: ssh tools run without a terminal, with
 * stdin closed and askpass off, except the one-time unlock, which hands the
 * passphrase to `ssh-add` through a throwaway askpass script.
 *
 * Logs name key files and the first characters of fingerprints, never key
 * contents and never a passphrase.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { collapseHome, expandHome, type SshStatus } from "@majhi/shared";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";

export const SSH_ADD = "/usr/bin/ssh-add";
export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
export const LAUNCHCTL = "/bin/launchctl";
/** Keys drop after sleep or an agent restart, so the helper checks again this often. */
/** How often the helper looks at the clock to notice a wake from sleep. Cheap: no ssh runs. */
export const WAKE_TICK_MS = 60_000;
/** A tick that arrives this much later than planned means the Mac slept in between. */
export const WAKE_GAP_MS = 2 * 60_000;

/** True when the time since the last tick shows the machine was asleep. */
export function isWake(lastTickAt: number, now: number, tickMs = WAKE_TICK_MS): boolean {
  return now - lastTickAt > tickMs + WAKE_GAP_MS;
}
const COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];

export interface RunOptions {
  env: Record<string, string>;
  timeoutMs: number;
  /** Written to the program's stdin, then closed. Absent: stdin is closed at once. */
  input?: string;
  /** Where the program runs. Absent: the helper's own folder. */
  cwd?: string;
}

/** Never rejects. `code` is null when the command could not start or timed out. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type RunFn = (file: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;

export interface SshDeps {
  run: RunFn;
  /** The file's text, or undefined when it does not exist. */
  readText: (path: string) => Promise<string | undefined>;
  exists: (path: string) => Promise<boolean>;
  home: string;
  /** The helper's own environment. Only PATH and SSH_AUTH_SOCK are read. */
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  now?: () => Date;
  /** Where the unlock's throwaway folder goes. */
  tmpRoot?: string;
  /** Report only: skip everything that changes the agent. */
  dryRun?: boolean;
}

/** The owner-facing reason an unlock failed. Safe to show and to log. */
export class SshUnlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshUnlockError";
  }
}

export type KeyState = "loaded" | "added" | "would-add" | "needs-passphrase" | "add-failed" | "unreadable";

export interface KeyReport {
  /** Path with `~`. */
  path: string;
  /** First characters of the SHA256 fingerprint, when the key could be read. */
  fingerprint: string | undefined;
  state: KeyState;
}

export interface SshReport {
  status: SshStatus;
  keys: KeyReport[];
  socket: string | undefined;
}

/** `IdentityFile` paths from an ssh config, absolute, in file order. Tokens it cannot resolve are skipped. */
export function parseIdentityFiles(config: string, home: string): string[] {
  const out: string[] = [];
  for (const line of config.split(/\r?\n/)) {
    const match = /^\s*IdentityFile(?:\s*=\s*|\s+)(.+?)\s*$/i.exec(line);
    if (match?.[1] === undefined) continue;
    let value = match[1];
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (value.toLowerCase() === "none") continue;
    value = value.replaceAll("%d", home).replaceAll("%%", "%");
    if (value.includes("%") || value.includes("${")) continue;
    value = expandHome(value, home);
    if (!isAbsolute(value)) continue;
    out.push(value.replace(/\.pub$/, ""));
  }
  return out;
}

/** Private key files that exist: the config's `IdentityFile` entries, then the default names. Each once. */
export async function discoverKeys(deps: Pick<SshDeps, "readText" | "exists" | "home">): Promise<string[]> {
  const config = (await deps.readText(join(deps.home, ".ssh", "config"))) ?? "";
  const candidates = [
    ...parseIdentityFiles(config, deps.home),
    ...DEFAULT_KEY_NAMES.map((name) => join(deps.home, ".ssh", name)),
  ];
  const found: string[] = [];
  for (const candidate of new Set(candidates)) {
    if (await deps.exists(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Public key files (`<key>.pub`) that exist, for the keys `~/.ssh/config` and the default names point to.
 * The private file need not exist. These are what majhi mounts read-only, so ssh in the container can
 * pick the matching agent key when the config says `IdentitiesOnly yes`.
 */
export async function discoverPublicKeys(
  deps: Pick<SshDeps, "readText" | "exists" | "home">,
): Promise<string[]> {
  const config = (await deps.readText(join(deps.home, ".ssh", "config"))) ?? "";
  const candidates = [
    ...parseIdentityFiles(config, deps.home),
    ...DEFAULT_KEY_NAMES.map((name) => join(deps.home, ".ssh", name)),
  ];
  const found: string[] = [];
  for (const candidate of new Set(candidates)) {
    if (await deps.exists(`${candidate}.pub`)) found.push(`${candidate}.pub`);
  }
  return found;
}

/** SHA256 fingerprints from `ssh-add -l` or `ssh-keygen -l` output, one per line. */
export function parseFingerprints(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const match = /\bSHA256:[A-Za-z0-9+/]+/.exec(line);
    if (match) out.push(match[0]);
  }
  return out;
}

/** `SHA256:AbCdEfGh...` shortened for the log. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^SHA256:/, "").slice(0, 8);
}

export interface Ssh {
  /** The result of the last check, or undefined before the first one ends. */
  status(): SshStatus | undefined;
  /** Loads keys into the agent and checks what is left. Calls queue, one at a time. */
  reload(): Promise<SshStatus>;
  /** Same as `reload` but returns the per-key report as well. */
  inspect(): Promise<SshReport>;
  /** Gives a key its passphrase once. Throws `SshUnlockError` with a plain message on refusal. */
  unlock(key: string, passphrase: string): Promise<SshStatus>;
  /**
   * Checks now (the helper starts at login) and again after every wake from sleep. Keys stay
   * loaded while the owner is logged in, so there is no periodic reload. The returned function stops it.
   */
  start(options?: { tickMs?: number; now?: () => number; onWake?: (at: Date) => void }): () => void;
}

export function createSsh(deps: SshDeps): Ssh {
  const { home, log } = deps;
  const now = deps.now ?? (() => new Date());
  const tmpRoot = deps.tmpRoot ?? tmpdir();
  let latest: SshStatus | undefined;
  let lastSocketNote = "";
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task, task);
    chain = result.catch(() => undefined);
    return result;
  };

  /** The launchd agent's socket: the helper's own value, else `launchctl getenv`. */
  async function findSocket(): Promise<string | undefined> {
    const own = deps.env.SSH_AUTH_SOCK?.trim() || undefined;
    const got = await deps.run(LAUNCHCTL, ["getenv", "SSH_AUTH_SOCK"], {
      env: baseEnv(),
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    const launchd = got.code === 0 ? got.stdout.trim() || undefined : undefined;
    const socket = own ?? launchd;
    const note = `${socket ?? "none"}|${launchd ?? ""}`;
    if (note !== lastSocketNote) {
      lastSocketNote = note;
      if (socket === undefined) log("no SSH agent socket in the helper's environment or from launchctl");
      else {
        const source = own === undefined ? "launchctl" : "the helper's environment";
        log(`SSH agent socket ${socket} (from ${source})`);
        if (own !== undefined && launchd !== undefined && own !== launchd) {
          log(`launchd holds a different agent socket, ${launchd}; the container is served by that one`);
        }
      }
    }
    return socket;
  }

  function baseEnv(socket?: string): Record<string, string> {
    const env: Record<string, string> = {
      PATH: deps.env.PATH || "/usr/bin:/bin",
      HOME: home,
      // Nothing may prompt. `never` turns askpass off; the false program is a second lock.
      SSH_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS_REQUIRE: "never",
    };
    if (socket !== undefined) env.SSH_AUTH_SOCK = socket;
    return env;
  }

  async function agentFingerprints(env: Record<string, string>): Promise<Set<string> | "unreachable"> {
    const list = await deps.run(SSH_ADD, ["-l"], { env, timeoutMs: COMMAND_TIMEOUT_MS });
    // Exit 1: the agent answered and holds no keys. Anything else but 0: it did not answer.
    if (list.code === 1) return new Set();
    if (list.code !== 0) return "unreachable";
    return new Set(parseFingerprints(list.stdout));
  }

  async function fingerprintOf(key: string, env: Record<string, string>): Promise<string | undefined> {
    const source = (await deps.exists(`${key}.pub`)) ? `${key}.pub` : key;
    const res = await deps.run(SSH_KEYGEN, ["-lf", source], { env, timeoutMs: COMMAND_TIMEOUT_MS });
    return res.code === 0 ? parseFingerprints(res.stdout)[0] : undefined;
  }

  async function check(): Promise<SshReport> {
    const checkedAt = now().toISOString();
    const socket = await findSocket();
    if (socket === undefined) {
      const status: SshStatus = {
        loaded: 0,
        needsPassphrase: [],
        error: "The Mac's SSH agent is not running, so there is nothing to load keys into.",
        checkedAt,
      };
      return { status, keys: [], socket };
    }
    const env = baseEnv(socket);
    if (!deps.dryRun) {
      // Apple's ssh-add only: it reads passphrases the Keychain already holds.
      const keychain = await deps.run(SSH_ADD, ["--apple-load-keychain"], {
        env,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (keychain.code !== 0)
        log(`ssh-add --apple-load-keychain ended with ${keychain.code ?? "no exit code"}`);
    }
    const before = await agentFingerprints(env);
    if (before === "unreachable") {
      const status: SshStatus = {
        loaded: 0,
        needsPassphrase: [],
        error: `Cannot reach the SSH agent at ${socket}.`,
        checkedAt,
      };
      return { status, keys: [], socket };
    }
    const loaded = new Set(before);
    const keys: KeyReport[] = [];
    for (const key of await discoverKeys(deps)) {
      const path = collapseHome(key, home);
      const fingerprint = await fingerprintOf(key, env);
      const short = fingerprint === undefined ? undefined : shortFingerprint(fingerprint);
      if (fingerprint !== undefined && loaded.has(fingerprint)) {
        keys.push({ path, fingerprint: short, state: "loaded" });
        continue;
      }
      // Success with an empty passphrase means the key has none.
      const probe = await deps.run(SSH_KEYGEN, ["-y", "-P", "", "-f", key], {
        env,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (probe.code === 0) {
        if (deps.dryRun) {
          keys.push({ path, fingerprint: short, state: "would-add" });
          continue;
        }
        const added = await deps.run(SSH_ADD, [key], { env, timeoutMs: COMMAND_TIMEOUT_MS });
        if (added.code === 0) {
          if (fingerprint !== undefined) loaded.add(fingerprint);
          log(`loaded ${path}${short === undefined ? "" : ` (${short})`}`);
          keys.push({ path, fingerprint: short, state: "added" });
        } else {
          log(`ssh-add could not load ${path} (exit ${added.code ?? "none"})`);
          keys.push({ path, fingerprint: short, state: "add-failed" });
        }
      } else if (/passphrase/i.test(probe.stderr)) {
        keys.push({ path, fingerprint: short, state: "needs-passphrase" });
      } else {
        keys.push({ path, fingerprint: short, state: "unreadable" });
      }
    }
    const after = deps.dryRun ? before : await agentFingerprints(env);
    if (after === "unreachable") {
      return {
        status: {
          loaded: 0,
          needsPassphrase: [],
          error: `Cannot reach the SSH agent at ${socket}.`,
          checkedAt,
        },
        keys,
        socket,
      };
    }
    const status: SshStatus = {
      loaded: after.size,
      needsPassphrase: keys.filter((k) => k.state === "needs-passphrase").map((k) => k.path),
      checkedAt,
    };
    return { status, keys, socket };
  }

  function summarize(status: SshStatus): string {
    const needs = status.needsPassphrase.length;
    const parts = [`${status.loaded} ${status.loaded === 1 ? "key" : "keys"} loaded`];
    if (needs > 0)
      parts.push(
        `${needs} need${needs === 1 ? "s" : ""} a passphrase (${status.needsPassphrase.join(", ")})`,
      );
    if (status.error !== undefined) parts.push(status.error);
    return parts.join(", ");
  }

  async function runCheck(): Promise<SshReport> {
    let report: SshReport;
    try {
      report = await check();
    } catch (err) {
      report = {
        status: { loaded: 0, needsPassphrase: [], error: errorMessage(err), checkedAt: now().toISOString() },
        keys: [],
        socket: undefined,
      };
    }
    latest = report.status;
    log(`SSH keys: ${summarize(report.status)}`);
    return report;
  }

  async function unlockNow(key: string, passphrase: string): Promise<SshStatus> {
    const shown = collapseHome(key, home);
    if (latest === undefined || !latest.needsPassphrase.includes(shown)) {
      throw new SshUnlockError(`${shown} is not waiting for a passphrase.`);
    }
    const socket = await findSocket();
    if (socket === undefined) throw new SshUnlockError("The Mac's SSH agent is not running.");
    const dir = await mkdtemp(join(tmpRoot, "majhi-askpass-"));
    let ok = false;
    try {
      await chmod(dir, 0o700);
      const secret = join(dir, "p");
      const script = join(dir, "askpass.sh");
      await writeFile(secret, passphrase, { mode: 0o600 });
      await writeFile(script, `#!/bin/sh\nexec /bin/cat '${secret}'\n`, { mode: 0o700 });
      const env: Record<string, string> = {
        ...baseEnv(socket),
        SSH_ASKPASS: script,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
      };
      // The result is judged by the exit code alone. Output is dropped: it names the key and nothing we need.
      const res = await deps.run(SSH_ADD, ["--apple-use-keychain", expandHome(key, home)], {
        env,
        timeoutMs: COMMAND_TIMEOUT_MS * 3,
      });
      ok = res.code === 0;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    if (!ok) {
      log(`unlock of ${shown} failed`);
      throw new SshUnlockError(`That passphrase did not unlock ${shown}.`);
    }
    log(`unlocked ${shown}; the Keychain holds its passphrase now`);
    return (await runCheck()).status;
  }

  return {
    status: () => latest,
    reload: () => enqueue(runCheck).then((r) => r.status),
    inspect: () => enqueue(runCheck),
    unlock: (key, passphrase) => enqueue(() => unlockNow(key, passphrase)),
    start({ tickMs = WAKE_TICK_MS, now = Date.now, onWake } = {}) {
      void enqueue(runCheck);
      let lastTick = now();
      const timer = setInterval(() => {
        const at = now();
        if (isWake(lastTick, at, tickMs)) {
          log("woke from sleep; checking SSH keys");
          onWake?.(new Date(at));
          void enqueue(runCheck);
        }
        lastTick = at;
      }, tickMs);
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
