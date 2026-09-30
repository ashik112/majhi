import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../spawn.ts";
import {
  dockerRunArgs,
  dockerSpawner,
  dockerTty,
  MountRefused,
  type RunnerConfig,
  runMounts,
} from "./docker.ts";

let root: string;
let home: string;
let majhiHome: string;
let cfg: RunnerConfig;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-runner-"));
  home = join(root, "Users", "owner");
  majhiHome = join(home, ".majhi");
  await mkdir(join(majhiHome, "accounts", "claude-acme"), { recursive: true });
  await mkdir(join(majhiHome, "accounts", "claude-globex"), { recursive: true });
  await mkdir(join(home, "Work", ".majhi", "ACM-1"), { recursive: true });
  await mkdir(join(home, "Work", "api", ".git", "hooks"), { recursive: true });
  await writeFile(join(home, "Work", "api", ".git", "config"), "[core]\n");
  await mkdir(join(root, "keys"), { recursive: true });
  await writeFile(join(root, "keys", "secrets.key"), "AGE-SECRET-KEY-1TEST\n");
  cfg = {
    image: "majhi-runner:dev",
    network: "majhi-runners",
    user: "501:20",
    cliEnv: { PATH: process.env.PATH ?? "/usr/bin" },
    majhiHome,
    protectedPaths: [join(root, "keys", "secrets.key")],
  };
});
afterEach(() => rm(root, { recursive: true, force: true }));

function request(extra: Partial<SpawnRequest> = {}): SpawnRequest {
  const repo = join(home, "Work", "api", ".git");
  return {
    command: { command: "claude-agent-acp", args: [] },
    env: {
      PATH: "/usr/bin",
      HOME: join(majhiHome, "accounts", "claude-acme"),
      ANTHROPIC_API_KEY: "sk-test-value-never-in-argv",
    },
    cwd: join(home, "Work", ".majhi", "ACM-1"),
    account: { tool: "claude", home: join(majhiHome, "accounts", "claude-acme") },
    mounts: [
      { path: repo },
      { path: join(repo, "config"), readOnly: true },
      { path: join(repo, "hooks"), readOnly: true },
    ],
    ...extra,
  };
}

const mountArgs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--mount" ? [a] : []));

describe("runner mounts", () => {
  it("mounts only the task folder, the repo's .git (config and hooks read-only) and the run's own account home", () => {
    const args = dockerRunArgs(request(), cfg, "majhi-run-test");
    const repo = join(home, "Work", "api", ".git");
    expect(mountArgs(args)).toEqual([
      `type=bind,source=${join(home, "Work", ".majhi", "ACM-1")},target=${join(home, "Work", ".majhi", "ACM-1")}`,
      `type=bind,source=${join(majhiHome, "accounts", "claude-acme")},target=${join(majhiHome, "accounts", "claude-acme")}`,
      `type=bind,source=${repo},target=${repo}`,
      `type=bind,source=${join(repo, "config")},target=${join(repo, "config")},readonly`,
      `type=bind,source=${join(repo, "hooks")},target=${join(repo, "hooks")},readonly`,
    ]);
    const joined = args.join(" ");
    expect(joined).not.toContain("secrets.key");
    expect(joined).not.toContain("claude-globex");
    expect(joined).not.toContain("docker.sock");
    expect(mountArgs(args).some((m) => m.includes(`source=${majhiHome},`))).toBe(false);
  });

  it("passes the environment by name only, so secrets never show in a process list", () => {
    const args = dockerRunArgs(request(), cfg, "majhi-run-test");
    expect(args.join(" ")).not.toContain("sk-test-value-never-in-argv");
    const envNames = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
    expect(envNames).toEqual([
      "ANTHROPIC_API_KEY",
      `HOME=${join(majhiHome, "accounts", "claude-acme")}`,
      "PATH=/usr/bin",
    ]);
  });

  it("runs as the owner, with no capabilities, on the runner network", () => {
    const args = dockerRunArgs(request(), cfg, "majhi-run-test");
    const pairs = (flag: string) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));
    expect(pairs("--user")).toEqual(["501:20"]);
    expect(pairs("--cap-drop")).toEqual(["ALL"]);
    expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
    expect(pairs("--network")).toEqual(["majhi-runners"]);
    expect(pairs("--workdir")).toEqual([join(home, "Work", ".majhi", "ACM-1")]);
    expect(args.slice(-2)).toEqual(["majhi-runner:dev", "claude-agent-acp"]);
  });

  it("gives a scratch run its own /tmp instead of a mount", () => {
    const args = dockerRunArgs(request({ scratch: true, mounts: [] }), cfg, "majhi-run-test");
    expect(mountArgs(args)).toHaveLength(1);
    expect(args[args.indexOf("--workdir") + 1]).toBe("/tmp");
  });

  it("refuses anything that exposes majhi's config folder, another account, the key or the Docker socket", async () => {
    const refused = (extra: Partial<SpawnRequest>) => () => runMounts(request(extra), cfg);
    // A task folder that holds the config folder.
    expect(refused({ cwd: home })).toThrow(MountRefused);
    // The config folder, its accounts folder, another account's home, agents and the database folder.
    for (const path of [
      majhiHome,
      join(majhiHome, "accounts"),
      join(majhiHome, "accounts", "claude-globex"),
      join(majhiHome, "agents"),
    ]) {
      expect(refused({ mounts: [{ path }] }), path).toThrow(MountRefused);
    }
    // An account home that is not directly an account of majhi.
    expect(refused({ account: { tool: "claude", home: majhiHome } })).toThrow(MountRefused);
    // The secrets key, its folder, and folders Docker itself uses.
    expect(refused({ mounts: [{ path: join(root, "keys") }] })).toThrow(MountRefused);
    expect(refused({ mounts: [{ path: join(root, "keys", "secrets.key") }] })).toThrow(MountRefused);
    expect(refused({ mounts: [{ path: "/var/run/docker.sock" }] })).toThrow(MountRefused);
    expect(refused({ mounts: [{ path: "/run/secrets/majhi_key" }] })).toThrow(MountRefused);
    expect(refused({ mounts: [{ path: "/" }] })).toThrow(MountRefused);
    expect(refused({ mounts: [{ path: "relative/path" }] })).toThrow(MountRefused);
    // A symlink that leads into the config folder.
    const link = join(home, "Work", "sneaky");
    await symlink(majhiHome, link);
    expect(refused({ mounts: [{ path: link }] })).toThrow(MountRefused);
    expect(refused({ cwd: link })).toThrow(MountRefused);
  });
});

describe("dockerSpawner", () => {
  it("starts the run through the docker CLI with values in its environment, and removes the container on kill", async () => {
    const log = join(root, "docker.log");
    const fake = join(root, "docker");
    // A stand-in docker CLI: records its argv and the key's value it can see, then echoes stdin.
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), key: process.env.ANTHROPIC_API_KEY ?? null }) + "\\n");
if (process.argv[2] === "run") process.stdin.pipe(process.stdout);
`,
    );
    await chmod(fake, 0o755);
    let ready = 0;
    const spawner = dockerSpawner({ ...cfg, docker: fake, ready: async () => void ready++ });
    const run = await spawner(request());
    expect(ready).toBe(1);
    expect(run.cwd).toBe(join(home, "Work", ".majhi", "ACM-1"));
    const echoed = new Promise<string>((done) =>
      run.child.stdout.once("data", (d: Buffer) => done(d.toString())),
    );
    run.child.stdin.write("ping\n");
    expect(await echoed).toBe("ping\n");
    run.kill();
    run.kill();
    for (let i = 0; i < 200; i++) {
      const lines = (await readFile(log, "utf8").catch(() => "")).trim().split("\n");
      if (lines.length >= 2) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; key: string | null });
    expect(calls).toHaveLength(2);
    const [started, removed] = calls;
    expect(started?.argv[0]).toBe("run");
    expect(started?.key).toBe("sk-test-value-never-in-argv");
    const name = started?.argv[started.argv.indexOf("--name") + 1];
    expect(removed?.argv).toEqual(["rm", "-f", name]);
    // The docker CLI that removes the container never gets the run's secrets.
    expect(removed?.key).toBeNull();
  });

  it("starts nothing when majhi is not ready to tell runners apart", async () => {
    const spawner = dockerSpawner({
      ...cfg,
      docker: "/nonexistent",
      ready: () => Promise.reject(new Error("no subnet")),
    });
    await expect(spawner(request())).rejects.toThrow("no subnet");
  });
});

describe("a task terminal in a runner", () => {
  /** What the terminal asks for: the task folder and its repo, no account, and the fixed environment. */
  function terminalRequest(extra: Partial<SpawnRequest> = {}): SpawnRequest {
    const { account: _account, env: _env, ...run } = request();
    return { ...run, command: { command: "/bin/sh", args: ["-c", "exec bash"] }, env: terminalEnv, ...extra };
  }
  const terminalEnv = { PATH: "/usr/bin", HOME: "/tmp", TERM: "xterm-256color", LANG: "C.UTF-8" };

  it("mounts the task's own folders and no account home", () => {
    const task = join(home, "Work", ".majhi", "ACM-1");
    const repo = join(home, "Work", "api", ".git");
    expect(runMounts(terminalRequest(), cfg).map((m) => m.path)).toEqual([
      task,
      repo,
      join(repo, "config"),
      join(repo, "hooks"),
    ]);
  });

  it("still refuses an account home or majhi's config folder as a mount", () => {
    for (const path of [
      join(majhiHome, "accounts", "claude-acme"),
      majhiHome,
      join(majhiHome, "majhi.yaml"),
    ]) {
      expect(() => runMounts(terminalRequest({ mounts: [{ path }] }), cfg)).toThrow(MountRefused);
    }
  });

  it("starts with a tty and shows no account, no majhi home and no secret in its arguments", () => {
    const args = dockerRunArgs(terminalRequest(), cfg, "majhi-term-test", { tty: true });
    expect(args.slice(0, 2)).toEqual(["run", "-it"]);
    const joined = args.join(" ");
    expect(joined).not.toContain(majhiHome);
    expect(joined).not.toContain("claude-acme");
    expect(joined).not.toContain("secrets.key");
    expect(joined).not.toContain("sk-test-value-never-in-argv");
    const env = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
    expect(env).toEqual(["HOME=/tmp", "LANG", "PATH=/usr/bin", "TERM"]);
  });

  it("runs the docker CLI in the pty, and removes the container on stop, once", async () => {
    const log = join(root, "docker.log");
    const fake = join(root, "docker");
    await writeFile(
      fake,
      `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`,
    );
    await chmod(fake, 0o755);
    const launch = await dockerTty({ ...cfg, docker: fake, ready: async () => undefined })(terminalRequest());
    expect(launch.command).toBe(fake);
    expect(launch.args.slice(0, 2)).toEqual(["run", "-it"]);
    // The CLI gets the terminal's own TERM and LANG by value, nothing of the server's environment.
    expect(launch.env).toMatchObject({ TERM: "xterm-256color", LANG: "C.UTF-8" });
    launch.stop();
    launch.stop();
    for (let i = 0; i < 200 && !(await readFile(log, "utf8").catch(() => "")).includes("rm"); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await new Promise((r) => setTimeout(r, 50));
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as string[]);
    expect(calls).toEqual([["rm", "-f", launch.args[launch.args.indexOf("--name") + 1]]]);
  });
});
