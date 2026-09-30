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
  ) {
    super(message);
  }
}

export const GIT_TIMEOUT_MS = 30_000;
export const FETCH_TIMEOUT_MS = 60_000;

/**
 * The environment of majhi's own git: the server's, so the forwarded SSH agent socket
 * (`SSH_AUTH_SOCK`) reaches fetches and pushes. Agent runs never get it (SPEC 4.5).
 */
export function gitEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...source,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: source.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };
}

/**
 * Runs `git` with an argument list, never through a shell. Prompts are off, so a
 * missing credential fails at once instead of hanging the server.
 */
export async function git(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await run("git", [...args], {
      cwd,
      timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(process.env),
    });
    return stdout;
  } catch (err) {
    const stderr = errText(err, "stderr");
    const first = stderr.trim().split("\n").slice(0, 3).join(" ").trim();
    const killed = typeof err === "object" && err !== null && "killed" in err && err.killed === true;
    throw new GitError(
      killed ? `git ${args[0] ?? ""} timed out` : first || `git ${args[0] ?? ""} failed`,
      args,
      stderr,
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
