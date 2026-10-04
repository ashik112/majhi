import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { dockerRunArgs, type RunnerConfig, runMounts } from "@majhi/acp";
import { afterEach, describe, expect, it } from "vitest";
import { createMajhi, type Majhi } from "../server.ts";
import { fakeRuntime } from "../testing/fakeRuntime.ts";
import { tempDir, testEnv } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { checkRunnerIsolation } from "./check.ts";
import { parseSubnets } from "./network.ts";
import { runnerSetup } from "./setup.ts";

let cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

const RUNNERS = "172.30.0.0/16|172.30.0.1";

async function containerMajhi(): Promise<{ majhi: Majhi; dir: string }> {
  const { dir, cleanup } = await tempDir();
  const base = testEnv(dir);
  const env = testEnv(dir, { runner: { ...base.runner, mode: "container" } });
  const majhi = createMajhi(env, {
    runtime: fakeRuntime(),
    runnerInspect: async () => parseSubnets(RUNNERS),
  });
  cleanups.push(async () => {
    await majhi.close();
    await cleanup();
  });
  await majhi.services.runner?.network.ensure();
  return { majhi, dir };
}

/** A request as @hono/node-server hands it over, from `address`. */
function from(majhi: Majhi, address: string, path: string, method = "POST"): Promise<Response> {
  return Promise.resolve(
    majhi.app.fetch(
      new Request(`http://majhi.test${path}`, { method, body: method === "POST" ? "{}" : null }),
      {
        incoming: { socket: { remoteAddress: address } },
      },
    ),
  );
}

describe("the runner network", () => {
  it("lets a runner reach only /mcp; the owner, through the gateway or loopback, reaches everything", async () => {
    const { majhi } = await containerMajhi();
    expect((await from(majhi, "172.30.0.9", "/api/cmd/config.get")).status).toBe(403);
    expect((await from(majhi, "::ffff:172.30.0.9", "/api/cmd/secrets.list")).status).toBe(403);
    expect((await from(majhi, "172.30.0.9", "/health", "GET")).status).toBe(403);
    expect((await from(majhi, "172.30.0.9", "/api/tasks/ACM-1/files/TASK.md", "GET")).status).toBe(403);
    // The MCP tools answer the runner (and ask for its token).
    expect((await from(majhi, "172.30.0.9", "/mcp")).status).toBe(401);
    expect((await from(majhi, "172.30.0.1", "/api/cmd/config.get")).status).toBe(200);
    expect((await from(majhi, "127.0.0.1", "/api/cmd/config.get")).status).toBe(200);
  });

  it("guards nothing when agents run next to majhi", async () => {
    const { dir, cleanup } = await tempDir();
    const majhi = createMajhi(testEnv(dir), { runtime: fakeRuntime() });
    cleanups.push(async () => {
      await majhi.close();
      await cleanup();
    });
    expect(majhi.services.runner).toBeUndefined();
    expect((await from(majhi, "172.30.0.9", "/api/cmd/config.get")).status).toBe(200);
  });
});

describe("what a task's run mounts", () => {
  let w: World;
  afterEach(() => w?.cleanup());

  it("asks for the repo's .git with config, hooks and other refs read-only, and passes the mount guard", async () => {
    w = await taskWorld();
    const created = await w.h.cmd("tasks.create", {
      text: "add a health endpoint to api from develop",
      repos: [{ project: "acme-api", base: "develop" }],
      start: true,
    });
    expect(created.status).toBe(200);
    await w.h.majhi.services.runs.idle();
    const start = w.h.runtime.starts[0];
    const gitDir = join(w.repo("api"), ".git");
    // The project's checkout comes first, read-only: the .git below it stays writable.
    expect(start?.mounts).toEqual([
      { path: w.repo("api"), readOnly: true },
      { path: gitDir },
      { path: join(gitDir, "config"), readOnly: true },
      { path: join(gitDir, "hooks"), readOnly: true },
      // Other checkouts' worktree entries, but the run's own.
      { path: join(gitDir, "worktrees"), readOnly: true },
      { path: join(gitDir, "worktrees", "acme-api") },
      // Branches, remote-tracking refs and tags, but majhi's task branches.
      { path: join(gitDir, "refs", "heads"), readOnly: true },
      { path: join(gitDir, "refs", "heads", "task") },
      { path: join(gitDir, "refs", "remotes"), readOnly: true },
      { path: join(gitDir, "refs", "tags"), readOnly: true },
      // majhi's own hooks (they keep the run on its branches), the one folder of its home a run may read.
      { path: join(w.h.env.majhiHome, "git-hooks"), readOnly: true },
      // The workspace's own package cache and tools folder, written by its runs; never another's.
      { path: join(w.h.env.majhiHome, "cache", "acme") },
      { path: join(w.h.env.majhiHome, "tools", "acme") },
    ]);
    expect(existsSync(join(gitDir, "hooks"))).toBe(true);

    // The same start, as the container runner would build it.
    const env = { ...w.h.env, runner: { ...w.h.env.runner, mode: "container" as const } };
    const config = runnerSetup(env, async () => parseSubnets(RUNNERS)).runner?.config as RunnerConfig;
    const request = {
      command: { command: "claude-agent-acp", args: [] },
      env: {},
      cwd: start?.cwd ?? "",
      account: start?.account ?? { tool: "claude" as const, home: "" },
      mounts: start?.mounts ?? [],
    };
    const mounts = runMounts(request, config).map((m) => m.path);
    expect(mounts).toEqual([
      w.taskDir("ACM-1"),
      join(w.h.env.majhiHome, "accounts", "claude-acme"),
      w.repo("api"),
      gitDir,
      join(gitDir, "config"),
      join(gitDir, "hooks"),
      join(gitDir, "worktrees"),
      join(gitDir, "worktrees", "acme-api"),
      join(gitDir, "refs", "heads"),
      join(gitDir, "refs", "heads", "task"),
      join(gitDir, "refs", "remotes"),
      join(gitDir, "refs", "tags"),
      join(w.h.env.majhiHome, "git-hooks"),
      join(w.h.env.majhiHome, "cache", "acme"),
      join(w.h.env.majhiHome, "tools", "acme"),
    ]);
    const args = dockerRunArgs(request, config, "majhi-run-x").join(" ");
    expect(args).not.toContain(`source=${w.h.env.majhiHome},`);
    expect(args).not.toContain(w.h.env.secretsKeyFile);
  });
});

describe("the runner isolation check", () => {
  it("starts a runner with only a probe account home, and passes when the runner sees nothing else", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const env = testEnv(dir);
    await mkdir(join(env.majhiHome, "accounts", "claude-acme"), { recursive: true });
    await mkdir(join(env.majhiHome, "accounts", "codex-globex"), { recursive: true });
    const runner = runnerSetup({ ...env, runner: { ...env.runner, mode: "container" } }, async () =>
      parseSubnets(RUNNERS),
    ).runner;
    if (runner === undefined) throw new Error("no runner");
    let seen: string[] = [];
    const verdict = await checkRunnerIsolation({
      runner,
      majhiHome: env.majhiHome,
      hostHome: env.hostHome,
      secretsKeyFile: env.secretsKeyFile,
      docker: async (args) => {
        seen = args;
        expect(existsSync(join(env.majhiHome, "accounts", "_runner-check", ".runner-check"))).toBe(true);
        return { stdout: "isolated\n" };
      },
    });
    expect(verdict).toEqual({
      ok: true,
      detail: "Agent runs are isolated: they cannot see ~/.majhi, the secrets key or other accounts.",
    });
    const probe = join(env.majhiHome, "accounts", "_runner-check");
    const mounts = seen.flatMap((a, i) => (seen[i - 1] === "--mount" ? [a] : []));
    expect(mounts).toEqual([`type=bind,source=${probe},target=${probe}`]);
    // Everything that must stay hidden is asked about.
    for (const hidden of [
      join(env.majhiHome, "majhi.yaml"),
      join(env.majhiHome, "run"),
      join(env.majhiHome, "accounts", "claude-acme"),
      join(env.majhiHome, "accounts", "codex-globex"),
      env.secretsKeyFile,
      "/var/run/docker.sock",
    ]) {
      expect(seen).toContain(hidden);
    }
    expect(existsSync(probe)).toBe(false);
  });

  it("fails with what the runner could see, or why it could not start", async () => {
    const { dir, cleanup } = await tempDir();
    cleanups.push(cleanup);
    const env = testEnv(dir);
    const runner = runnerSetup({ ...env, runner: { ...env.runner, mode: "container" } }, async () =>
      parseSubnets(RUNNERS),
    ).runner;
    if (runner === undefined) throw new Error("no runner");
    const input = {
      runner,
      majhiHome: env.majhiHome,
      hostHome: env.hostHome,
      secretsKeyFile: env.secretsKeyFile,
    };
    const seeing = Object.assign(new Error("Command failed"), {
      stdout: `a run can see ${env.secretsKeyFile}\n`,
    });
    expect(await checkRunnerIsolation({ ...input, docker: () => Promise.reject(seeing) })).toEqual({
      ok: false,
      detail: `a run can see ${env.secretsKeyFile}`,
    });
    const missing = new Error("Unable to find image 'majhi-runner:dev' locally");
    expect(await checkRunnerIsolation({ ...input, docker: () => Promise.reject(missing) })).toEqual({
      ok: false,
      detail: "The runner image majhi-runner:dev is missing, so agents cannot run.",
      rebuild: true,
    });
  });
});
