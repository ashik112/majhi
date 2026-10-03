/**
 * Keeps the SSH agent loaded so majhi's own git can reach remotes over
 * SSH through the forwarded socket (SPEC 4.5). Private keys never leave
 * this computer. Nothing here ever prompts: ssh tools run without a
 * terminal, with stdin closed and askpass off, except when a key gets its
 * passphrase, which goes to `ssh-add` through a throwaway askpass script.
 *
 * Logs name key files and the first characters of fingerprints, never key
 * contents and never a passphrase.
 */
import { access, chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { collapseHome, expandHome, type SshStatus, sshUnlockCommand } from "@majhi/shared";
import { errorMessage } from "./errors.ts";
import type { Logger } from "./log.ts";
import {
  type Keyring,
  type PassphraseKeeping,
  type SshAgentPlatform,
  sshPassphraseItem,
} from "./platform/types.ts";

/** Apple's own ssh tools, which know the Keychain. Elsewhere the ones on PATH are used. */
export const SSH_ADD = "/usr/bin/ssh-add";
export const SSH_KEYGEN = "/usr/bin/ssh-keygen";
/** Keys drop after sleep or an agent restart, so the helper checks again this often. */
/** How often the helper looks at the clock to notice a wake from sleep. Cheap: no ssh runs. */
export const WAKE_TICK_MS = 60_000;
/** A tick that arrives this much later than planned means the computer slept in between. */
export const WAKE_GAP_MS = 2 * 60_000;

/** True when the time since the last tick shows the machine was asleep. */
export function isWake(lastTickAt: number, now: number, tickMs = WAKE_TICK_MS): boolean {
  return now - lastTickAt > tickMs + WAKE_GAP_MS;
}
const COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];
const NO_TOOLS =
  "ssh-add and ssh-keygen are not installed. Install openssh-client (Debian, Ubuntu) or openssh.";

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
  /** The PATH the ssh tools run with. */
  path: string;
  /** The absolute path of the first executable `name` on `path`, or undefined. */
  find: (name: string) => Promise<string | undefined>;
  /** The agent keys are loaded into, and where a passphrase is kept. */
  agent: Pick<SshAgentPlatform, "socket" | "passphrases">;
  /** Where passphrases are kept when `agent.passphrases()` is `keyring`. */
  keyring: Pick<Keyring, "read" | "write" | "remove">;
  log: Logger;
  now?: () => Date;
  /**
   * `$XDG_RUNTIME_DIR`. The askpass's throwaway folder goes there while the folder exists: it is the
   * owner's alone, and in memory under systemd.
   */
  runtimeDir?: string | undefined;
  /** Where the askpass's throwaway folder goes otherwise. Absent: the system's temp folder. */
  tmpRoot?: string;
  /** Report only: skip everything that changes the agent or the keyring. */
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

/** True when the file is there. For the askpass's own folder, which is never the owner's. */
function onDisk(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** `text` as one single-quoted sh word. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * An askpass that gives the passphrase in `<dir>/p` once. ssh-add asks a second time only when the
 * passphrase was wrong; that question gets an empty answer, which ends ssh-add at once, and leaves
 * `<dir>/again` behind. Only shell builtins, so it runs where `/bin/cat` is missing.
 */
function askpassScript(dir: string): string {
  const asked = shellQuote(join(dir, "asked"));
  return [
    "#!/bin/sh",
    `if [ -e ${asked} ]; then`,
    `  : > ${shellQuote(join(dir, "again"))}`,
    "  exit 1",
    "fi",
    `: > ${asked}`,
    `IFS= read -r p < ${shellQuote(join(dir, "p"))}`,
    `printf '%s\\n' "$p"`,
    "",
  ].join("\n");
}

/** The ssh tools, the agent they run against, and where a passphrase is kept. */
interface Session {
  sshAdd: string;
  sshKeygen: string;
  keeping: PassphraseKeeping;
  socket: string;
  env: Record<string, string>;
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
  let chain: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = chain.then(task, task);
    chain = result.catch(() => undefined);
    return result;
  };

  function baseEnv(socket: string): Record<string, string> {
    return {
      PATH: deps.path || "/usr/bin:/bin",
      HOME: home,
      // Nothing may prompt. `never` turns askpass off; the false program is a second lock.
      SSH_ASKPASS: "/usr/bin/false",
      SSH_ASKPASS_REQUIRE: "never",
      SSH_AUTH_SOCK: socket,
    };
  }

  /** The tools and the agent, or why there are none, in plain words. */
  async function openSession(noAgent: string): Promise<Session | { error: string }> {
    const keeping = await deps.agent.passphrases();
    let sshAdd = SSH_ADD;
    let sshKeygen = SSH_KEYGEN;
    if (keeping !== "apple") {
      const [add, keygen] = await Promise.all([deps.find("ssh-add"), deps.find("ssh-keygen")]);
      if (add === undefined || keygen === undefined) return { error: NO_TOOLS };
      sshAdd = add;
      sshKeygen = keygen;
    }
    const socket = await deps.agent.socket();
    if (socket === undefined) return { error: noAgent };
    return { sshAdd, sshKeygen, keeping, socket, env: baseEnv(socket) };
  }

  async function agentFingerprints(session: Session): Promise<Set<string> | "unreachable"> {
    const list = await deps.run(session.sshAdd, ["-l"], { env: session.env, timeoutMs: COMMAND_TIMEOUT_MS });
    // Exit 1: the agent answered and holds no keys. Anything else but 0: it did not answer.
    if (list.code === 1) return new Set();
    if (list.code !== 0) return "unreachable";
    return new Set(parseFingerprints(list.stdout));
  }

  async function fingerprintOf(session: Session, key: string): Promise<string | undefined> {
    const source = (await deps.exists(`${key}.pub`)) ? `${key}.pub` : key;
    const res = await deps.run(session.sshKeygen, ["-lf", source], {
      env: session.env,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    return res.code === 0 ? parseFingerprints(res.stdout)[0] : undefined;
  }

  /** `$XDG_RUNTIME_DIR` while it is a folder, else `tmpRoot`. Looked up each time: logging out removes it. */
  async function askpassRoot(): Promise<string> {
    const runtime = deps.runtimeDir;
    if (runtime === undefined || !isAbsolute(runtime)) return tmpRoot;
    const folder = await stat(runtime).then(
      (s) => s.isDirectory(),
      () => false,
    );
    return folder ? runtime : tmpRoot;
  }

  /**
   * `ssh-add key` with its passphrase, through the askpass in a private folder that is removed
   * after. `wrong` when ssh-add asked again, which it does only for a wrong passphrase.
   * `not-asked` when it stopped before it ran the askpass, so the passphrase was never tried.
   * `failed` when it asked once and still failed, like an agent that refused the key.
   */
  async function addWithPassphrase(
    session: Session,
    key: string,
    passphrase: string,
  ): Promise<"added" | "wrong" | "failed" | "not-asked"> {
    const dir = await mkdtemp(join(await askpassRoot(), "majhi-askpass-"));
    try {
      await chmod(dir, 0o700);
      const script = join(dir, "askpass.sh");
      await writeFile(join(dir, "p"), passphrase, { mode: 0o600 });
      await writeFile(script, askpassScript(dir), { mode: 0o700 });
      const env: Record<string, string> = {
        ...session.env,
        SSH_ASKPASS: script,
        SSH_ASKPASS_REQUIRE: "force",
        DISPLAY: ":0",
      };
      // Apple's ssh-add keeps the passphrase in the Keychain as it adds the key.
      const args = session.keeping === "apple" ? ["--apple-use-keychain", key] : [key];
      // The result is judged by the exit code and the askpass's marks. Output is logged only when
      // ssh-add failed for another reason than a wrong passphrase, to say why; it never holds the passphrase.
      const res = await deps.run(session.sshAdd, args, { env, timeoutMs: COMMAND_TIMEOUT_MS * 3 });
      if (res.code === 0) return "added";
      const asked = await onDisk(join(dir, "asked"));
      if (asked && (await onDisk(join(dir, "again")))) return "wrong";
      const why = res.stderr.trim().split("\n").at(-1) || `exit ${res.code ?? "none"}`;
      const shown = collapseHome(key, home);
      log(
        asked
          ? `ssh-add took the passphrase of ${shown} once, then stopped: ${why}`
          : `ssh-add stopped before it asked for the passphrase of ${shown}: ${why}`,
      );
      return asked ? "failed" : "not-asked";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** A key that needs a passphrase, loaded with the one the keyring kept for it. A wrong one is removed. */
  async function loadKept(session: Session, key: string, path: string, label: string): Promise<KeyState> {
    if (session.keeping !== "keyring" || deps.dryRun) return "needs-passphrase";
    const item = sshPassphraseItem(path);
    let kept: string | undefined;
    try {
      kept = await deps.keyring.read(item);
    } catch (err) {
      log(`could not read the kept passphrase for ${path}: ${errorMessage(err)}`);
    }
    if (kept === undefined) return "needs-passphrase";
    const added = await addWithPassphrase(session, key, kept);
    if (added === "added") {
      log(`loaded ${label} with its kept passphrase`);
      return "added";
    }
    if (added === "failed" || added === "not-asked") {
      log(`ssh-add could not load ${path} with its kept passphrase`);
      return "add-failed";
    }
    try {
      await deps.keyring.remove(item);
      log(`the kept passphrase for ${path} no longer unlocks it, so it was removed from the keyring`);
    } catch (err) {
      log(
        `the kept passphrase for ${path} no longer unlocks it, and removing it failed: ${errorMessage(err)}`,
      );
    }
    return "needs-passphrase";
  }

  async function check(): Promise<SshReport> {
    const checkedAt = now().toISOString();
    const failure = (error: string, socket?: string, keys: KeyReport[] = []): SshReport => ({
      status: { loaded: 0, needsPassphrase: [], error, checkedAt },
      keys,
      socket,
    });
    const session = await openSession("The SSH agent is not running, so there is nothing to load keys into.");
    if ("error" in session) return failure(session.error);
    const { env, socket } = session;
    if (session.keeping === "apple" && !deps.dryRun) {
      // Apple's ssh-add only: it reads passphrases the Keychain already holds.
      const keychain = await deps.run(session.sshAdd, ["--apple-load-keychain"], {
        env,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (keychain.code !== 0)
        log(`ssh-add --apple-load-keychain ended with ${keychain.code ?? "no exit code"}`);
    }
    const before = await agentFingerprints(session);
    if (before === "unreachable") return failure(`Cannot reach the SSH agent at ${socket}.`, socket);
    const loaded = new Set(before);
    const keys: KeyReport[] = [];
    for (const key of await discoverKeys(deps)) {
      const path = collapseHome(key, home);
      const fingerprint = await fingerprintOf(session, key);
      const short = fingerprint === undefined ? undefined : shortFingerprint(fingerprint);
      const label = `${path}${short === undefined ? "" : ` (${short})`}`;
      if (fingerprint !== undefined && loaded.has(fingerprint)) {
        keys.push({ path, fingerprint: short, state: "loaded" });
        continue;
      }
      // Success with an empty passphrase means the key has none.
      const probe = await deps.run(session.sshKeygen, ["-y", "-P", "", "-f", key], {
        env,
        timeoutMs: COMMAND_TIMEOUT_MS,
      });
      if (probe.code === 0) {
        if (deps.dryRun) {
          keys.push({ path, fingerprint: short, state: "would-add" });
          continue;
        }
        const added = await deps.run(session.sshAdd, [key], { env, timeoutMs: COMMAND_TIMEOUT_MS });
        if (added.code === 0) {
          if (fingerprint !== undefined) loaded.add(fingerprint);
          log(`loaded ${label}`);
          keys.push({ path, fingerprint: short, state: "added" });
        } else {
          log(`ssh-add could not load ${path} (exit ${added.code ?? "none"})`);
          keys.push({ path, fingerprint: short, state: "add-failed" });
        }
      } else if (/passphrase/i.test(probe.stderr)) {
        const state = await loadKept(session, key, path, label);
        if (state === "added" && fingerprint !== undefined) loaded.add(fingerprint);
        keys.push({ path, fingerprint: short, state });
      } else {
        keys.push({ path, fingerprint: short, state: "unreadable" });
      }
    }
    const after = deps.dryRun ? before : await agentFingerprints(session);
    if (after === "unreachable") return failure(`Cannot reach the SSH agent at ${socket}.`, socket, keys);
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
    const session = await openSession("The SSH agent is not running.");
    if ("error" in session) throw new SshUnlockError(session.error);
    const added = await addWithPassphrase(session, expandHome(key, home), passphrase);
    // Apple's tools mean macOS. Linux and WSL2 share one command.
    const command = sshUnlockCommand(shown, session.keeping === "apple" ? "macos" : "linux");
    if (added === "not-asked") {
      throw new SshUnlockError(
        `The passphrase was not tried: ssh-add stopped before it asked for it. Unlock ${shown} in a terminal: ${command}`,
      );
    }
    if (added === "failed") {
      throw new SshUnlockError(
        `ssh-add could not load ${shown}. Unlock it in a terminal to see why: ${command}`,
      );
    }
    if (added !== "added") {
      log(`unlock of ${shown} failed`);
      throw new SshUnlockError(`That passphrase did not unlock ${shown}.`);
    }
    if (session.keeping === "apple") log(`unlocked ${shown}; the Keychain holds its passphrase now`);
    else if (session.keeping === "none")
      log(`unlocked ${shown}; with no keyring, its passphrase is kept nowhere`);
    else {
      try {
        await deps.keyring.write(sshPassphraseItem(shown), passphrase);
        log(`unlocked ${shown}; the keyring holds its passphrase now`);
      } catch (err) {
        log(`unlocked ${shown}, but the keyring did not keep its passphrase: ${errorMessage(err)}`);
      }
    }
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
