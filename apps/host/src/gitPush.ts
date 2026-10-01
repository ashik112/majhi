/**
 * Pushes and reads saved logins on the Mac, where the Keychain and `gh` live, because the server's
 * container cannot reach them. Nothing here prompts, forces or returns a credential in a message:
 * errors are fixed sentences, and git's own output is scrubbed of `https://user:pass@` forms.
 */
import { isAbsolute } from "node:path";
import type { RunFn } from "./ssh.ts";

const PUSH_TIMEOUT_MS = 120_000;
const CREDENTIAL_TIMEOUT_MS = 30_000;

export interface GitPushDeps {
  run: RunFn;
  home: string;
  /** The helper's PATH, already extended with the usual tool folders (so `gh` is found). */
  path: string;
  kind: (path: string) => Promise<"file" | "directory" | undefined>;
}

export interface PushParams {
  path: string;
  url: string;
  branch: string;
}

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isPlainHttps(url: string): boolean {
  if (/[\s\0]/.test(url)) return false;
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.password === "" &&
      /^[a-z0-9.-]+$/i.test(u.hostname) &&
      u.pathname.length > 1
    );
  } catch {
    return false;
  }
}

/** The `git push` arguments, or a thrown refusal. Only an https URL and a plain branch are accepted. */
export function pushArgs({ url, branch }: Pick<PushParams, "url" | "branch">): string[] {
  if (!isPlainHttps(url)) throw new Error("Only https remotes can be pushed from the Mac.");
  if (
    !BRANCH.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    /[:+~^?*[\\]/.test(branch)
  ) {
    throw new Error("That is not a plain branch name. majhi never forces or deletes through a push.");
  }
  return ["push", "--quiet", url, `refs/heads/${branch}:refs/heads/${branch}`];
}

/** Drops `user:pass@` (and a lone token) from every URL in `text`. */
export function stripCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1");
}

/** Looks like git could not log in. */
export function isHttpsAuthFailure(text: string): boolean {
  return /authentication failed|could not read (username|password)|terminal prompts disabled|invalid credentials|http 40[13]|returned error: 40[13]|permission to .* denied|access denied|bad credentials/i.test(
    text,
  );
}

function env(deps: GitPushDeps): Record<string, string> {
  return {
    PATH: deps.path,
    HOME: deps.home,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "that host";
  }
}

function userOf(url: string): string | undefined {
  try {
    const user = new URL(url).username;
    return user === "" ? undefined : decodeURIComponent(user);
  } catch {
    return undefined;
  }
}

/** `git push <url> <branch>` in `path` with the owner's own git config. Throws a message safe to show. */
export async function gitPush(deps: GitPushDeps, params: PushParams): Promise<void> {
  const args = pushArgs(params);
  if (!isAbsolute(params.path) || params.path.includes("\0")) throw new Error("The path must be absolute.");
  if ((await deps.kind(params.path)) !== "directory")
    throw new Error(`There is no folder at ${params.path} on this Mac.`);
  const run = await deps.run("git", ["-C", params.path, ...args], {
    env: env(deps),
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  if (run.code === 0) return;
  const text = stripCredentials(`${run.stderr}\n${run.stdout}`);
  if (run.code === null) throw new Error("git push did not finish in time on this Mac.");
  if (isHttpsAuthFailure(text)) {
    const user = userOf(params.url);
    throw new Error(
      `This Mac has no saved login for ${user === undefined ? "an account" : user} on ${hostOf(params.url)}. Paste a token for the org, or use an SSH key.`,
    );
  }
  const reason = text.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  throw new Error(`git push failed: ${reason === "" ? "no output" : reason}`);
}

/** The saved https secret of `username` on `host`, from `git credential fill`. Throws a fixed sentence. */
export async function gitCredential(
  deps: GitPushDeps,
  { host, username }: { host: string; username: string },
): Promise<string> {
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) throw new Error("That is not a git host name.");
  if (/[\r\n\0]/.test(username)) throw new Error("That is not an account name.");
  const run = await deps.run("git", ["credential", "fill"], {
    env: env(deps),
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    input: `protocol=https\nhost=${host}\nusername=${username}\n\n`,
  });
  const secret = /^password=(.+)$/m.exec(run.stdout)?.[1]?.trim();
  if (run.code !== 0 || secret === undefined || secret === "") {
    throw new Error(`This Mac has no saved login for ${username} on ${host}.`);
  }
  return secret;
}
