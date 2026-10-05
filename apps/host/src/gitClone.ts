/**
 * Clone and ls-remote with a workspace's own credential, on the owner's computer. git runs with
 * majhi's askpass (see gitAuth.ts), never prompts, and never asks a system credential helper.
 * Errors are fixed sentences: git's raw output never leaves this file.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { type ClonePhase, cloneTempPath, type GitAuth, type HostCloneProgress } from "@majhi/shared";
import { type AuthEnvDeps, gitAuthEnv } from "./gitAuth.ts";
import { UPLOAD_PACK } from "./gitGuard.ts";
import { stripCredentials } from "./gitPush.ts";
import type { RunFn } from "./ssh.ts";

const CLONE_TIMEOUT_MS = 60 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 50_000;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export interface GitCloneDeps extends Omit<AuthEnvDeps, "sshAuthSock"> {
  run: RunFn;
  /** The ssh agent socket, looked up when an ssh job runs. */
  socket: () => Promise<string | undefined>;
  /** Replaces the streaming spawn, for tests. */
  spawnGit?: StreamingRun;
}

/** Runs git, handing each stderr line (split on `\r` and `\n`) to `onLine`. Never rejects. */
export type StreamingRun = (
  args: readonly string[],
  options: { env: Record<string, string>; cwd: string; timeoutMs: number; onLine: (line: string) => void },
) => Promise<{ code: number | null; stderr: string }>;

const MAX_STDERR = 64 * 1024;

export const streamingGit: StreamingRun = (args, options) =>
  new Promise((resolve) => {
    let stderr = "";
    let partial = "";
    let settled = false;
    const child = spawn("git", [...args], {
      env: options.env,
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (partial !== "") options.onLine(partial);
      resolve({ code, stderr });
    };
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      finish(null);
    }, options.timeoutMs);
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (stderr.length < MAX_STDERR) stderr += text;
      const parts = (partial + text).split(/[\r\n]/);
      partial = parts.pop() ?? "";
      for (const line of parts) if (line.trim() !== "") options.onLine(line);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

const PHASES: readonly [RegExp, ClonePhase][] = [
  [/^(remote: )?(Enumerating|Counting) objects:/i, "counting"],
  [/^(remote: )?Compressing objects:/i, "compressing"],
  [/^Receiving objects:/i, "receiving"],
  [/^Resolving deltas:/i, "resolving"],
  [/^(Updating files|Checking out files):/i, "checkout"],
];

/** The phase and percent of one line of `git clone --progress`, or undefined for any other line. */
export function parseProgress(line: string): Omit<HostCloneProgress, "id"> | undefined {
  const text = line.trim();
  for (const [pattern, phase] of PHASES) {
    if (!pattern.test(text)) continue;
    const percent = /:\s+(\d{1,3})%/.exec(text)?.[1];
    const value = percent === undefined ? undefined : Math.min(100, Number(percent));
    return { phase, ...(value === undefined ? {} : { percent: value }) };
  }
  return undefined;
}

/** A plain sentence for a failed git network command. Never git's output, never a URL with credentials. */
export function failureReason(stderr: string, url: string, code: number | null): string {
  const text = stripCredentials(stderr);
  if (code === null) return "git did not finish in time on this computer.";
  if (
    /authentication failed|could not read (username|password)|terminal prompts disabled|invalid credentials|returned error: 40[13]|http 40[13]|bad credentials|access denied/i.test(
      text,
    )
  ) {
    return "The git host refused the workspace's credential. Sign the workspace in again.";
  }
  if (/permission denied \(publickey|host key verification failed/i.test(text)) {
    return "No SSH key on this computer could log in for this repo. Check the workspace's SSH route.";
  }
  if (
    /not found|does not exist|does not appear to be a git repository|repository .* not found|returned error: 404/i.test(
      text,
    )
  ) {
    return "The repo was not found, or the workspace's account cannot see it.";
  }
  if (
    /could not resolve host|failed to connect|connection (timed out|refused)|network is unreachable/i.test(
      text,
    )
  ) {
    return `This computer could not reach ${hostOf(url)}.`;
  }
  return "git could not reach the repo.";
}

function hostOf(url: string): string {
  const https = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url);
  if (https?.[1] !== undefined) return https[1];
  const scp = /^(?:[^@/:]+@)?([^/:]+):/.exec(url);
  return scp?.[1] ?? "the git host";
}

async function pathState(path: string): Promise<"missing" | "empty" | "taken"> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return "taken";
    return (await readdir(path)).length === 0 ? "empty" : "taken";
  } catch {
    return "missing";
  }
}

async function env(deps: GitCloneDeps, auth: GitAuth) {
  return gitAuthEnv({ ...deps, ...(auth.kind === "ssh" ? { sshAuthSock: await deps.socket() } : {}) }, auth);
}

/**
 * `git clone --progress` into a temporary sibling of `path`, renamed to `path` when done. The
 * temporary folder is removed whatever happens. Refuses a `path` that exists and is not empty.
 */
export async function gitClone(
  deps: GitCloneDeps,
  params: { clone: string; url: string; path: string; branch?: string | undefined; auth: GitAuth },
  progress: (progress: Omit<HostCloneProgress, "id">) => void,
): Promise<{ head: string; branch: string }> {
  if (!isAbsolute(params.path) || params.path.includes("\0")) throw new Error("The path must be absolute.");
  if (/^-/.test(params.url) || /[\s\0]/.test(params.url)) throw new Error("That is not a git remote URL.");
  if (params.branch !== undefined && (!BRANCH.test(params.branch) || params.branch.includes(".."))) {
    throw new Error("That is not a plain branch name.");
  }
  if ((await pathState(params.path)) === "taken") {
    throw new Error(`${params.path} already exists and is not empty.`);
  }
  const parent = dirname(params.path);
  await mkdir(parent, { recursive: true });
  const temp = cloneTempPath(params.path, params.clone);
  await rm(temp, { recursive: true, force: true });
  const auth = await env(deps, params.auth);
  const spawnGit = deps.spawnGit ?? streamingGit;
  try {
    progress({ phase: "connecting" });
    const run = await spawnGit(
      [
        ...auth.config,
        "clone",
        "--progress",
        ...(params.branch === undefined ? [] : ["--branch", params.branch]),
        "--",
        params.url,
        temp,
      ],
      {
        env: auth.env,
        cwd: parent,
        timeoutMs: CLONE_TIMEOUT_MS,
        onLine: (line) => {
          const found = parseProgress(line);
          if (found !== undefined) progress(found);
        },
      },
    );
    if (run.code !== 0) throw new Error(failureReason(run.stderr, params.url, run.code));
    const plain = { env: { PATH: deps.path, HOME: deps.home, LC_ALL: "C" }, timeoutMs: 20_000 };
    const head = await deps.run("git", ["-C", temp, "rev-parse", "--verify", "--quiet", "HEAD"], plain);
    if (head.code !== 0 || !/^[0-9a-f]{7,64}$/.test(head.stdout.trim())) {
      throw new Error(
        "The repo is empty, so there is nothing to clone. Use New project, then connect it to this repo.",
      );
    }
    const branch = await deps.run("git", ["-C", temp, "symbolic-ref", "--short", "HEAD"], plain);
    if (branch.code !== 0 || branch.stdout.trim() === "")
      throw new Error("The clone has no branch checked out.");
    if ((await pathState(params.path)) === "taken") {
      throw new Error(`${params.path} filled up while the clone ran. Nothing was changed there.`);
    }
    await rename(temp, params.path);
    progress({ phase: "checkout", percent: 100 });
    return { head: head.stdout.trim(), branch: branch.stdout.trim() };
  } finally {
    await auth.cleanup();
    await rm(temp, { recursive: true, force: true });
  }
}

/** `git ls-remote --symref`: whether the remote is reachable, empty, and where its HEAD points. */
export async function gitLsRemote(
  deps: GitCloneDeps,
  params: { url: string; auth: GitAuth },
): Promise<{ empty: boolean; defaultBranch?: string }> {
  if (/^-/.test(params.url) || /[\s\0]/.test(params.url)) throw new Error("That is not a git remote URL.");
  const auth = await env(deps, params.auth);
  try {
    const args = [...auth.config, "ls-remote", UPLOAD_PACK, "--symref", "--", params.url];
    const run = await deps.run("git", args, {
      env: auth.env,
      // Not in the helper's folder: ls-remote reads the repo config of where it runs, and that may be a broken checkout.
      cwd: deps.majhiHome,
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    });
    if (run.code !== 0) throw new Error(failureReason(run.stderr, params.url, run.code));
    const lines = run.stdout.split("\n");
    const head = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(run.stdout)?.[1];
    const empty = !lines.some((l) => /\trefs\/heads\//.test(l));
    return { empty, ...(head === undefined ? {} : { defaultBranch: head }) };
  } finally {
    await auth.cleanup();
  }
}
