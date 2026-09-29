import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Git for test setup, isolated from the machine's own git config. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
  );
  return stdout.trim();
}

/** Creates `path` as a real git repo with the given remotes and an optional first commit. */
export async function makeRepo(
  path: string,
  options: { remotes?: Record<string, string>; branch?: string; commit?: boolean } = {},
): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "--quiet", `--initial-branch=${options.branch ?? "main"}`);
  for (const [name, url] of Object.entries(options.remotes ?? {}))
    await git(path, "remote", "add", name, url);
  if (options.commit) await git(path, "commit", "--quiet", "--allow-empty", "-m", "init");
}

/** A fresh temp folder, with symlinks resolved so paths compare equal. Returns it and a cleanup. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-test-")));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
