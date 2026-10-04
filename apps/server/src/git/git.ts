import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { KeyedQueue } from "./keyed-queue.ts";

const run = promisify(execFile);

/** A git command failed. The message is git's own first lines, for the owner to read. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
    /** What git printed before it failed, and its exit code, when it ran at all. */
    readonly stdout: string = "",
    readonly exitCode?: number | undefined,
  ) {
    super(message);
  }
}

export const GIT_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 60_000;

/**
 * The environment of majhi's own git: the server's, so the forwarded SSH agent socket
 * (`SSH_AUTH_SOCK`) reaches fetches and pushes. Agent runs never get it (SPEC 4.5). Never a run's
 * `MAJHI_TASK`, which majhi's hooks read as "this is that task's agent": majhi started by an agent
 * (its tests, a dev server) still makes and moves every task's branches. Never the caller's
 * `GIT_AUTHOR_*` or `GIT_COMMITTER_*` either: they win over `-c user.name`, so a merge, revert or
 * rebase would be made as whoever started majhi instead of the identity it names.
 *
 * `GIT_OPTIONAL_LOCKS=0` is set for every command (git's documentation: the same as
 * `--no-optional-locks`; git skips only sub-operations that take an optional lock). A read such as
 * `git status` otherwise refreshes the index and takes `index.lock`, which made a merge or rebase
 * running in the same worktree fail with "Unable to create index.lock". It changes nothing for a write.
 */
export function gitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    MAJHI_TASK: _run,
    MAJHI_BRANCHES: _branches,
    MAJHI_GIT_DIRS: _dirs,
    MAJHI_TRAILER: _trailer,
    ...rest
  } = source;
  for (const key of Object.keys(rest)) if (/^GIT_(AUTHOR|COMMITTER)_/.test(key)) delete rest[key];
  return {
    ...rest,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: source.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

/**
 * What keeps a repo from running commands in majhi's git. An agent can edit its worktree's
 * `.gitattributes` and, outside a container, `.git/config`, and majhi's git runs in that worktree and
 * in the project's checkout. So hooks, fsmonitor and `ext::` remotes are off for every command; the
 * filter and merge drivers, remote commands and signing programs the repo sets are turned off
 * (`repoCommands`);
 * and diffs get `--no-ext-diff --no-textconv`. `core.sshCommand` needs nothing: `gitEnv` always
 * sets `GIT_SSH_COMMAND`, which wins. majhi's own hooks reach only runs, through the run's
 * environment (`buildEnv`), so nothing here relied on them, and an agent's git in a run is unchanged.
 */
const SERVER_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
];

/** Commands that run textconv or an external diff unless told not to. */
const DIFF_COMMANDS = new Set(["diff", "log", "show", "whatchanged"]);

/**
 * Commands that never read a file's content, merge or reach a remote, so nothing `repoCommands`
 * turns off can run: no lookup.
 */
const NO_LOOKUP = new Set([
  "rev-parse",
  "symbolic-ref",
  "rev-list",
  "merge-base",
  "update-ref",
  "for-each-ref",
  "show-ref",
  "remote",
  "config",
]);

/**
 * Settings that name a command git runs when it reaches a remote, where the last value wins:
 * askpass for a password and the command that lists an alternate's refs. When the repo sets one,
 * it gets the owner's own value (global, system or command line), else nothing.
 */
const REMOTE_COMMANDS: readonly RegExp[] = [/^core\.askpass$/, /^core\.alternaterefscommand$/];

/**
 * The programs that sign or check a signature, and the settings that make `log`, `show`, `merge`,
 * `pull`, `commit`, `tag` and `push` sign or check one. When the repo sets one, it gets the owner's
 * own value (the last one), else git's default: a signature is then neither made nor checked unless
 * the owner asks for it, and only with the owner's program.
 */
const SIGNING: ReadonlyMap<string, string> = new Map([
  ["gpg.program", "gpg"],
  ["gpg.openpgp.program", "gpg"],
  ["gpg.x509.program", "gpgsm"],
  ["gpg.ssh.program", "ssh-keygen"],
  ["gpg.ssh.defaultkeycommand", ""],
  ["log.showsignature", "false"],
  ["merge.verifysignatures", "false"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["tag.forcesignannotated", "false"],
  ["push.gpgsign", "false"],
]);

/**
 * The upload-pack or receive-pack a command runs for a remote on a local path or `file://`. git
 * keeps the first `remote.<name>.uploadpack` it reads, so the repo's beats the command line; the
 * command's own option beats both. When the repo sets one, the option names the owner's own value,
 * else git's default.
 */
const PACK_OPTIONS: Readonly<Record<string, { option: string; key: RegExp; fallback: string }>> = {
  fetch: { option: "--upload-pack", key: /^remote\..+\.uploadpack$/, fallback: "git-upload-pack" },
  pull: { option: "--upload-pack", key: /^remote\..+\.uploadpack$/, fallback: "git-upload-pack" },
  "ls-remote": { option: "--upload-pack", key: /^remote\..+\.uploadpack$/, fallback: "git-upload-pack" },
  push: { option: "--receive-pack", key: /^remote\..+\.receivepack$/, fallback: "git-receive-pack" },
};

/** `credential.helper` and `credential.<url>.helper`: one list, in config order. */
const HELPER = /^credential\.(.+\.)?helper$/;

/** Every key `repoCommands` reads, as git's own regexp. */
const REPO_COMMAND_KEYS =
  "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver|credential\\.(.+\\.)?helper" +
  "|remote\\..+\\.(uploadpack|receivepack)|core\\.(askpass|alternaterefscommand|gitproxy)" +
  "|gpg\\.((openpgp|x509|ssh)\\.)?program|gpg\\.ssh\\.defaultkeycommand|log\\.showsignature" +
  "|merge\\.verifysignatures|(commit|tag|push)\\.gpgsign|tag\\.forcesignannotated)$";

interface ConfigEntry {
  scope: string;
  key: string;
  value: string | undefined;
}

/** The repo's own config: its `.git/config`, its worktree config and what they include. */
function fromRepo(entry: ConfigEntry): boolean {
  return entry.scope === "local" || entry.scope === "worktree";
}

/**
 * The commands the repo's own config names, turned off; the owner's global and system settings
 * stay on. A filter converts nothing and is not required, a merge driver fails, which git reports
 * as a conflict; turning the owner's drivers off (git-lfs, say) would commit LFS files whole. A
 * credential helper the repo adds is dropped by emptying the list and adding the owner's helpers
 * back in order, so osxkeychain still answers. `core.gitProxy` takes the first entry that matches,
 * and the repo's come before the command line, so it is overridden with `GIT_PROXY_COMMAND`: the
 * server's own, else none, which also drops an owner's `core.gitProxy` for that repo (git:// only).
 * Upload-pack and receive-pack go in `options` (`PACK_OPTIONS`), signing as in `SIGNING`.
 * `url.<base>.insteadOf` cannot be dropped (the first of equal rewrites wins), but every command it
 * could point a remote at is off here or in `SERVER_CONFIG`. Nothing when git cannot tell. Read
 * with `git config`, which runs nothing.
 */
async function repoCommands(
  cwd: string,
  env: NodeJS.ProcessEnv,
  command: string,
): Promise<{ settings: (readonly [string, string])[]; env: NodeJS.ProcessEnv; options: string[] }> {
  const listed = await run("git", ["config", "-z", "--show-scope", "--get-regexp", REPO_COMMAND_KEYS], {
    cwd,
    env,
    timeout: GIT_TIMEOUT_MS,
  }).then(
    ({ stdout }) => stdout.split("\0"),
    () => [],
  );
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < listed.length; i += 2) {
    const [scope = "", item = ""] = [listed[i], listed[i + 1]];
    const at = item.indexOf("\n");
    entries.push(
      at === -1
        ? { scope, key: item, value: undefined }
        : { scope, key: item.slice(0, at), value: item.slice(at + 1) },
    );
  }
  const planted = entries.filter(fromRepo);
  const owners = entries.filter((e) => !fromRepo(e));
  const own = (key: string, last: boolean) => {
    const values = owners.filter((e) => e.key === key && e.value !== undefined);
    return (last ? values.at(-1) : values[0])?.value;
  };
  const off = new Map<string, string>();
  const pack = PACK_OPTIONS[command];
  let option: string | undefined;
  for (const { key } of planted) {
    const driver = key.slice(0, key.lastIndexOf("."));
    if (key.startsWith("filter.")) {
      for (const name of ["clean", "smudge", "process"]) off.set(`${driver}.${name}`, "");
      off.set(`${driver}.required`, "false");
    } else if (key.startsWith("merge.")) {
      off.set(key, "false");
    } else if (REMOTE_COMMANDS.some((c) => c.test(key))) {
      off.set(key, own(key, true) ?? "");
    } else if (SIGNING.has(key)) {
      off.set(key, own(key, true) ?? SIGNING.get(key) ?? "");
    } else if (pack?.key.test(key)) {
      option = `${pack.option}=${own(key, false) ?? pack.fallback}`;
    }
  }
  const settings: (readonly [string, string])[] = [...off];
  if (planted.some((e) => HELPER.test(e.key))) {
    settings.push(["credential.helper", ""]);
    for (const e of owners) if (HELPER.test(e.key) && e.value !== undefined) settings.push([e.key, e.value]);
  }
  const proxy = planted.some((e) => e.key === "core.gitproxy");
  return {
    settings,
    env: proxy ? { GIT_PROXY_COMMAND: env.GIT_PROXY_COMMAND ?? "" } : {},
    options: option === undefined ? [] : [option],
  };
}

/**
 * Adds settings in the command-line scope, after any already there, so they win over the repo's.
 * Through the environment, not `-c`, which cuts a key at its first `=`: a driver's name may hold one.
 */
function withConfig(
  env: NodeJS.ProcessEnv,
  settings: readonly (readonly [string, string])[],
): NodeJS.ProcessEnv {
  const had = Number(env.GIT_CONFIG_COUNT ?? 0);
  const start = Number.isInteger(had) && had > 0 ? had : 0;
  const out: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(start + settings.length) };
  settings.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${start + i}`] = key;
    out[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return out;
}

/** Where the command's name is, past git's own options (`-c <setting>`, `-C <dir>`, `--no-pager`). */
function commandAt(args: readonly string[]): number {
  let i = 0;
  while (i < args.length && args[i]?.startsWith("-")) i += args[i] === "-c" || args[i] === "-C" ? 2 : 1;
  return i;
}

/** Commands that write the index (and so take `index.lock`) or the work tree. */
const INDEX_WRITERS = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "merge",
  "mv",
  "pull",
  "read-tree",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
]);

/**
 * Multi-step writes: when one stops on a lock halfway it leaves its own state behind (a rebase in
 * progress), so running it again would not be a retry. They are queued but never retried.
 */
const NO_RETRY = new Set(["am", "cherry-pick", "merge", "pull", "rebase", "revert", "stash"]);

/** One write at a time per worktree: majhi's merge, rebase, checkpoint commit and revert never overlap. */
const writes = new KeyedQueue();

/** How long a write waits for a lock someone else holds, before it gives up. */
export const LOCK_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000, 2000];

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Runs `git` with an argument list, never through a shell. Prompts are off, so a
 * missing credential fails at once instead of hanging the server. The repo cannot make it run
 * a command (`SERVER_CONFIG`).
 */
export async function git(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBufferBytes?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const command = args[commandAt(args)] ?? "";
  if (!INDEX_WRITERS.has(command)) return gitOnce(cwd, args, options);
  return writes.run(resolve(cwd), async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await gitOnce(cwd, args, options);
      } catch (err) {
        // This worktree's write queue is held here, so the lock git hit is not majhi's own write: it
        // is an agent's git in a container or the owner's. Wait for it; never remove it.
        const wait = LOCK_RETRY_DELAYS_MS[attempt];
        if (wait === undefined || NO_RETRY.has(command) || !(err instanceof GitError)) throw err;
        if (!err.stderr.includes("index.lock")) throw err;
        await sleep(wait);
      }
    }
  });
}

async function gitOnce(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBufferBytes?: number; env?: Record<string, string> },
): Promise<string> {
  try {
    const at = commandAt(args);
    const command = args[at] ?? "";
    const base = { ...gitEnv(process.env), ...options.env };
    const off = NO_LOOKUP.has(command)
      ? { settings: [], env: {}, options: [] }
      : await repoCommands(cwd, base, command);
    const extra = DIFF_COMMANDS.has(command) ? ["--no-ext-diff", "--no-textconv"] : off.options;
    const argv = [...args.slice(0, at + 1), ...extra, ...args.slice(at + 1)];
    const { stdout } = await run("git", argv, {
      cwd,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
      env: { ...withConfig(base, [...SERVER_CONFIG, ...off.settings]), ...off.env },
    });
    return stdout;
  } catch (err) {
    const stderr = errText(err, "stderr");
    const first = stderr.trim().split("\n").slice(0, 3).join(" ").trim();
    const killed = typeof err === "object" && err !== null && "killed" in err && err.killed === true;
    const tooBig =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    throw new GitError(
      tooBig
        ? `git ${args[0] ?? ""} printed too much to read`
        : killed
          ? `git ${args[0] ?? ""} timed out`
          : first || `git ${args[0] ?? ""} failed`,
      args,
      stderr,
      typeof err === "object" && err !== null && "stdout" in err && typeof err.stdout === "string"
        ? err.stdout
        : "",
      typeof err === "object" && err !== null && "code" in err && typeof err.code === "number"
        ? err.code
        : undefined,
    );
  }
}

/** True when the command exits with 0. Any failure, including a missing repo, counts as no. */
export async function gitOk(cwd: string, args: readonly string[]): Promise<boolean> {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function errText(err: unknown, key: "stderr" | "stdout"): string {
  if (typeof err === "object" && err !== null && key in err) {
    const value = (err as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return err instanceof Error ? err.message : String(err);
}

/** True when `path` holds a `.git` folder or file the server can see. */
export async function isGitRepo(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** The remote tasks fetch from: `origin`, else the first remote, else none. */
export async function remoteOf(repo: string): Promise<string | undefined> {
  const remotes = (await git(repo, ["remote"])).split("\n").filter((r) => r !== "");
  return remotes.includes("origin") ? "origin" : remotes[0];
}

/** `origin/HEAD` without the remote name, else the branch checked out now. */
export async function defaultBranch(repo: string): Promise<string | undefined> {
  try {
    const ref = (await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // No origin/HEAD: fall back to the current branch.
  }
  try {
    const branch = (await git(repo, ["symbolic-ref", "--short", "HEAD"])).trim();
    return branch === "" ? undefined : branch;
  } catch {
    return undefined;
  }
}

export function localBranchExists(repo: string, name: string): Promise<boolean> {
  return gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);
}

export function remoteBranchExists(repo: string, remote: string, name: string): Promise<boolean> {
  return gitOk(repo, ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${name}`]);
}

/** Lines of `git status --porcelain`: what is changed or untracked. Empty when clean. */
export async function uncommitted(worktree: string): Promise<string[]> {
  const out = await git(worktree, ["status", "--porcelain"]);
  return out.split("\n").filter((l) => l !== "");
}

/** Tracked and untracked, not ignored, files. Paths are relative to `cwd`. */
export async function listFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter((p) => p !== "");
}

/** Untracked, not ignored, files. Paths are relative to `cwd`. */
export async function listUntracked(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter((p) => p !== "");
}
