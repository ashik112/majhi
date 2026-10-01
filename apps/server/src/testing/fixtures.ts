import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ServerEnv } from "../env.ts";

const run = promisify(execFile);

/**
 * The environment a test's git starts from. A test run by an agent inherits that agent's commit
 * identity, hooks and task from majhi, so those are dropped: a commit a test makes is nobody's.
 */
function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_(AUTHOR|COMMITTER)_|^GIT_CONFIG_(COUNT|KEY_|VALUE_)|^MAJHI_(TASK|BRANCHES|GIT_DIRS|TRAILER)$/.test(
        key,
      )
    )
      delete env[key];
  }
  return env;
}

/** Git for test setup, isolated from the machine's own git config. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...cleanGitEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } },
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

/** A server environment rooted in a temp folder. The secrets key file lives outside the majhi home, as in production. */
export function testEnv(dir: string, overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    host: "127.0.0.1",
    port: 0,
    hostHome: dir,
    majhiHome: join(dir, ".majhi"),
    webDist: join(dir, "web-dist"),
    version: "1.2.3-test",
    commit: "dev",
    secretsKeyFile: join(dir, "config", "secrets.key"),
    runtime: { base: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, adapters: {} },
    // Tests never reach the network; they inject a probe when they test offline.
    netProbe: "off",
    runner: {
      mode: "local",
      image: "majhi-runner:dev",
      network: "majhi-runners",
      mcpHost: "majhi-server",
      memory: "4g",
      // Never the real CLI: a test must not touch the machine's containers.
      docker: "/nonexistent/docker",
      cliEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
    ...overrides,
  };
}

/** Makes a majhi-like environment: a temp home with `majhi.yaml` roots set, plus a secrets key file when asked. */
export async function writeKeyFile(path: string, identity: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `# test key\n${identity}\n`, { mode: 0o600 });
}
