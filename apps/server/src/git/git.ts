import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
 * (its tests, a dev server) still makes and moves every task's branches.
 */
export function gitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const {
    MAJHI_TASK: _run,
    MAJHI_BRANCHES: _branches,
    MAJHI_GIT_DIRS: _dirs,
    MAJHI_TRAILER: _trailer,
    ...rest
  } = source;
  return {
    ...rest,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: source.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

/**
 * What keeps a repo from running commands in majhi's git. An agent can edit its worktree's
 * `.gitattributes` and, outside a container, `.git/config`, and majhi's git runs in that worktree and
 * in the project's checkout. So hooks, fsmonitor and `ext::` remotes are off for every command; the
 * filter and merge drivers the repo defines are turned off by name (`repoDrivers`); and diffs get
 * `--no-ext-diff --no-textconv`. majhi's own hooks reach only runs, through the run's environment
 * (`buildEnv`), so nothing here relied on them, and an agent's git in a run is unchanged.
 */
const SERVER_CONFIG: readonly (readonly [string, string])[] = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["protocol.ext.allow", "never"],
];

/** Commands that run textconv or an external diff unless told not to. */
const DIFF_COMMANDS = new Set(["diff", "log", "show", "whatchanged"]);

/** Commands that never read a file's content or merge, so no driver can run: no lookup. */
const NO_DRIVERS = new Set([
  "rev-parse",
  "symbolic-ref",
  "rev-list",
  "merge-base",
  "update-ref",
  "for-each-ref",
  "show-ref",
  "ls-remote",
  "remote",
  "config",
]);

/**
 * The filter and merge drivers the repo's own config sets a command for (its `.git/config`, its
 * worktree config and what they include), turned off: a filter converts nothing and is not
 * required, a merge driver fails, which git reports as a conflict. The owner's global and system
 * drivers (git-lfs, say) stay on: turning those off would commit LFS files whole. Empty when there
 * are none or git cannot tell. Read with `git config`, which runs nothing.
 */
async function repoDrivers(cwd: string, env: NodeJS.ProcessEnv): Promise<(readonly [string, string])[]> {
  const listed = await run(
    "git",
    [
      "config",
      "-z",
      "--show-scope",
      "--name-only",
      "--get-regexp",
      "^(filter\\..+\\.(clean|smudge|process)|merge\\..+\\.driver)$",
    ],
    { cwd, env, timeout: GIT_TIMEOUT_MS },
  ).then(
    ({ stdout }) => stdout.split("\0"),
    () => [],
  );
  const off = new Map<string, string>();
  for (let i = 0; i + 1 < listed.length; i += 2) {
    const [scope, key = ""] = [listed[i], listed[i + 1]];
    if (scope !== "local" && scope !== "worktree") continue;
    const driver = key.slice(0, key.lastIndexOf("."));
    if (key.startsWith("filter.")) {
      for (const name of ["clean", "smudge", "process"]) off.set(`${driver}.${name}`, "");
      off.set(`${driver}.required`, "false");
    } else if (key.endsWith(".driver")) {
      off.set(key, "false");
    }
  }
  return [...off];
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
  try {
    const at = commandAt(args);
    const command = args[at] ?? "";
    const base = { ...gitEnv(process.env), ...options.env };
    const drivers = NO_DRIVERS.has(command) ? [] : await repoDrivers(cwd, base);
    const argv = DIFF_COMMANDS.has(command)
      ? [...args.slice(0, at + 1), "--no-ext-diff", "--no-textconv", ...args.slice(at + 1)]
      : [...args];
    const { stdout } = await run("git", argv, {
      cwd,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
      env: withConfig(base, [...SERVER_CONFIG, ...drivers]),
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
