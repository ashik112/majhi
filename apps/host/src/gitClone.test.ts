import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { cloneTempPath } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ensureAskpass } from "./gitAuth.ts";
import { type GitCloneDeps, gitClone, type StreamingRun, streamingGit } from "./gitClone.ts";
import { GUARD_CONFIG } from "./gitGuard.ts";
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
});
