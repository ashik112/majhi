import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cloneTempPath } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ASKPASS_SCRIPT, ensureAskpass, gitAuthEnv } from "./gitAuth.ts";
import { type GitCloneDeps, gitClone, gitLsRemote, type StreamingRun, streamingGit } from "./gitClone.ts";
import { GUARD_CONFIG } from "./gitGuard.ts";
import { type GitPushDeps, gitPush } from "./gitPush.ts";
import { runCommand } from "./runCommand.ts";

const exec = promisify(execFile);
const TOKEN = "ghp_HostSideSecretToken123456";
const PATH = process.env.PATH ?? "/usr/bin:/bin";

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

async function temp(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-host-")));
  dirs.push(dir);
  return dir;
}

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec("git", ["-c", "user.name=T", "-c", "user.email=t@acme.test", ...args], { cwd, env })
  ).stdout.trim();

/** A bare repo with one commit on `trunk`, served as a local path. */
async function bareRepo(dir: string): Promise<string> {
  const src = join(dir, "src");
  await mkdir(src);
  await git(src, "init", "--quiet", "--initial-branch=trunk");
  await writeFile(join(src, "README.md"), "# demo\n");
  await git(src, "add", ".");
  await git(src, "commit", "--quiet", "-m", "first");
  const bare = join(dir, "demo.git");
  await git(dir, "clone", "--quiet", "--bare", src, bare);
  return bare;
}

async function deps(dir: string, spawnGit?: StreamingRun): Promise<GitCloneDeps> {
  const majhiHome = join(dir, ".majhi");
  return {
    majhiHome,
    askpass: await ensureAskpass(majhiHome),
    path: PATH,
    home: dir,
    run: runCommand,
    socket: async () => undefined,
    ...(spawnGit === undefined ? {} : { spawnGit }),
  };
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

describe("askpass", () => {
  it("prints the user name for a username prompt and the file's token for a password prompt", async () => {
    const dir = await temp();
    const d = await deps(dir);
    expect(await readFile(d.askpass, "utf8")).toBe(ASKPASS_SCRIPT);
    expect((await stat(d.askpass)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, ".majhi", "host"))).mode & 0o777).toBe(0o700);
    const auth = await gitAuthEnv(d, { kind: "token", username: "x-access-token", password: TOKEN });
    // The token is in no environment variable, and its file is readable by the owner only.
    expect(JSON.stringify(auth.env)).not.toContain(TOKEN);
    expect(auth.config).toEqual([...GUARD_CONFIG, "-c", "credential.helper=", "-c", "core.askPass="]);
    const file = auth.env.MAJHI_ASKPASS_FILE ?? "";
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const ask = (prompt: string) => exec(d.askpass, [prompt], { env: auth.env }).then((r) => r.stdout);
    expect(await ask("Username for 'https://github.com': ")).toBe("x-access-token\n");
    expect(await ask("Password for 'https://x-access-token@github.com': ")).toBe(TOKEN);
    await auth.cleanup();
    expect(await exists(file)).toBe(false);
  });
});

describe("gitClone", () => {
  it("clones into a temporary sibling, renames it, reports progress, and keeps the token out of argv and env", async () => {
    const dir = await temp();
    const bare = await bareRepo(dir);
    const seen: { args: readonly string[]; env: Record<string, string> }[] = [];
    let tokenFile = "";
    const spy: StreamingRun = async (args, options) => {
      seen.push({ args, env: options.env });
      tokenFile = options.env.MAJHI_ASKPASS_FILE ?? "";
      expect(await readFile(tokenFile, "utf8")).toBe(TOKEN);
      return streamingGit(args, options);
    };
    const target = join(dir, "Work", "acme", "demo");
    const progress: unknown[] = [];
    const out = await gitClone(
      await deps(dir, spy),
      {
        clone: "cl_AAAAAAAAAAAAAAAA",
        url: bare,
        path: target,
        auth: { kind: "token", username: "x-access-token", password: TOKEN },
      },
      (p) => progress.push(p),
    );
    expect(out.branch).toBe("trunk");
    expect(out.head).toMatch(/^[0-9a-f]{40}$/);
    expect(await readFile(join(target, "README.md"), "utf8")).toBe("# demo\n");
    expect(await exists(cloneTempPath(target, "cl_AAAAAAAAAAAAAAAA"))).toBe(false);
    expect(progress[0]).toEqual({ phase: "connecting" });
    expect(progress.at(-1)).toEqual({ phase: "checkout", percent: 100 });
    const call = seen[0];
    expect(call?.args.join(" ")).not.toContain(TOKEN);
    expect(JSON.stringify(call?.env)).not.toContain(TOKEN);
    expect(call?.args.slice(0, 10)).toEqual([
      ...GUARD_CONFIG,
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
    ]);
    expect(call?.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(await exists(tokenFile)).toBe(false);
    // Nothing of the job is left in the helper's folder.
    expect((await readdir(join(dir, ".majhi", "host"))).sort()).toEqual(["askpass.sh"]);
  });

  it("clones into an empty folder, and refuses one that is not empty", async () => {
    const dir = await temp();
    const bare = await bareRepo(dir);
    const d = await deps(dir);
    const target = join(dir, "Work", "acme", "demo");
    await mkdir(target, { recursive: true });
    await gitClone(
      d,
      { clone: "cl_BBBBBBBBBBBBBBBB", url: bare, path: target, auth: { kind: "none" } },
      () => undefined,
    );
    await expect(
      gitClone(
        d,
        { clone: "cl_CCCCCCCCCCCCCCCC", url: bare, path: target, auth: { kind: "none" } },
        () => undefined,
      ),
    ).rejects.toThrow(/already exists and is not empty/);
  });

  it("removes the temporary folder and the token file when the clone fails, with a plain reason", async () => {
    const dir = await temp();
    const target = join(dir, "Work", "acme", "nope");
    const missing = join(dir, "missing.git");
    const err = await gitClone(
      await deps(dir),
      {
        clone: "cl_DDDDDDDDDDDDDDDD",
        url: missing,
        path: target,
        auth: { kind: "token", username: "oauth2", password: TOKEN },
      },
      () => undefined,
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(TOKEN);
    expect(await exists(target)).toBe(false);
    expect(await exists(cloneTempPath(target, "cl_DDDDDDDDDDDDDDDD"))).toBe(false);
    expect((await readdir(join(dir, ".majhi", "host"))).sort()).toEqual(["askpass.sh"]);
  });
});

describe("gitLsRemote", () => {
  it("tells an empty remote from one with commits, and its default branch", async () => {
    const dir = await temp();
    const bare = await bareRepo(dir);
    const empty = join(dir, "empty.git");
    await mkdir(empty);
    await git(empty, "init", "--bare", "--quiet");
    const d = await deps(dir);
    expect(await gitLsRemote(d, { url: bare, auth: { kind: "none" } })).toEqual({
      empty: false,
      defaultBranch: "trunk",
    });
    expect(await gitLsRemote(d, { url: empty, auth: { kind: "none" } })).toEqual({ empty: true });
  });
});

describe("gitPush with a workspace token", () => {
  it("drops the URL's user, uses askpass, never puts the token in argv, and refuses without auth support", async () => {
    let call: { args: readonly string[]; env: Record<string, string> } | undefined;
    const dir = await temp();
    const d = await deps(dir);
    const pushDeps: GitPushDeps = {
      run: async (_f, args, o) => {
        call = { args, env: o.env };
        return { code: 0, stdout: "", stderr: "" };
      },
      home: dir,
      path: PATH,
      kind: async () => "directory",
      authEnv: (auth) => gitAuthEnv(d, auth),
    };
    await gitPush(pushDeps, {
      path: dir,
      url: "https://octo@github.com/acme/api.git",
      branch: "main",
      auth: { kind: "token", username: "x-access-token", password: TOKEN },
    });
    expect(call?.args).toEqual([
      "-C",
      dir,
      ...GUARD_CONFIG,
      "-c",
      "credential.helper=",
      "-c",
      "core.askPass=",
      "push",
      "--receive-pack=git-receive-pack",
      "--quiet",
      "https://github.com/acme/api.git",
      "refs/heads/main:refs/heads/main",
    ]);
    expect(JSON.stringify(call)).not.toContain(TOKEN);
    expect(call?.env.GIT_ASKPASS).toBe(d.askpass);
    const { authEnv: _a, ...noAuth } = pushDeps;
    await expect(
      gitPush(noAuth, {
        path: dir,
        url: "https://github.com/acme/api.git",
        branch: "main",
        auth: { kind: "token", username: "u", password: TOKEN },
      }),
    ).rejects.toThrow(/cannot push with a workspace's token/);
  });
});
