/**
 * How the helper's git authenticates with a workspace's own credential (`GitAuth`), on any
 * platform: plain git and a small POSIX askpass script, never a system credential helper.
 *
 * Token handling. The token reaches git through majhi's askpass and a file, never argv or the
 * environment:
 * - The askpass script lives in the helper's own folder (`<MAJHI_HOME>/host`, mode 700) and is
 *   written once per start. It prints `MAJHI_GIT_USERNAME` for a username prompt and the contents
 *   of the file named by `MAJHI_ASKPASS_FILE` for a password prompt.
 * - For each job the helper makes a fresh folder (mode 700) under that folder, writes the token to
 *   a file in it (mode 600), and removes the folder when git exits, whatever happened.
 * - git's child processes see the file's path, not the token. `ps` and `/proc/<pid>/environ` show
 *   no token. Only processes of the same user can read the file, for the seconds the job runs.
 * - `-c credential.helper=` empties the helper list, so osxkeychain, libsecret or wincred is
 *   neither asked nor told to store anything; `GIT_TERMINAL_PROMPT=0` stops every prompt.
 * Alternatives weighed: the token in an environment variable (readable by same-user processes
 * through `ps eww` on some systems for as long as git runs, and inherited by every hook and
 * subprocess), and a named pipe (one read per pipe, while git may ask twice; not portable to WSL
 * drives).
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitAuth } from "@majhi/shared";
import { GUARD_CONFIG, GUARD_ENV } from "./gitGuard.ts";

export const ASKPASS_SCRIPT = `#!/bin/sh
# majhi askpass: answers git's prompts for one job. Written by majhi's host helper.
case "$1" in
  Username*|username*) printf '%s\\n' "$MAJHI_GIT_USERNAME" ;;
  *) [ -n "$MAJHI_ASKPASS_FILE" ] && cat "$MAJHI_ASKPASS_FILE" ;;
esac
`;

/** `<MAJHI_HOME>/host`, the helper's private folder. */
export function helperDir(majhiHome: string): string {
  return join(majhiHome, "host");
}

/** Writes the askpass script into the helper's private folder (mode 700) and returns its path. */
export async function ensureAskpass(majhiHome: string): Promise<string> {
  const dir = helperDir(majhiHome);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const file = join(dir, "askpass.sh");
  await writeFile(file, ASKPASS_SCRIPT, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

export interface GitAuthEnv {
  /** Environment for the git child, with no token in it. */
  env: Record<string, string>;
  /** `-c` options that come before the git command. */
  config: string[];
  /** Removes the job's token file. Safe to call twice. */
  cleanup: () => Promise<void>;
}

export interface AuthEnvDeps {
  majhiHome: string;
  /** The askpass script, from `ensureAskpass`. */
  askpass: string;
  path: string;
  home: string;
  /** The ssh agent socket, for `ssh` auth. */
  sshAuthSock?: string | undefined;
}

/**
 * The environment and `-c` options to run git with for one job. Only PATH, HOME, what the auth
 * needs and the guards that keep a repo from running commands (gitGuard.ts): the helper's own
 * environment is not passed on.
 */
export async function gitAuthEnv(deps: AuthEnvDeps, auth: GitAuth): Promise<GitAuthEnv> {
  const env: Record<string, string> = {
    PATH: deps.path,
    HOME: deps.home,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    LC_ALL: "C",
    ...GUARD_ENV,
  };
  const config = [...GUARD_CONFIG, "-c", "credential.helper=", "-c", "core.askPass="];
  if (auth.kind === "ssh") {
    if (deps.sshAuthSock !== undefined) env.SSH_AUTH_SOCK = deps.sshAuthSock;
    return { env, config, cleanup: async () => undefined };
  }
  if (auth.kind === "none") return { env, config, cleanup: async () => undefined };
  const parent = helperDir(deps.majhiHome);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, "job-"));
  await chmod(dir, 0o700);
  const file = join(dir, "password");
  let done = false;
  const cleanup = async () => {
    if (done) return;
    done = true;
    await rm(dir, { recursive: true, force: true });
  };
  try {
    await writeFile(file, auth.password, { mode: 0o600 });
    await chmod(file, 0o600);
  } catch (err) {
    await cleanup();
    throw err;
  }
  env.GIT_ASKPASS = deps.askpass;
  env.MAJHI_ASKPASS_FILE = file;
  env.MAJHI_GIT_USERNAME = auth.username;
  return { env, config, cleanup };
}
