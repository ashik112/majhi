import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localSpawner, type Spawner } from "@majhi/acp";
import type { Task } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execInTask, maskSecrets } from "./exec.ts";

let dir: string | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function run(command: string, timeoutMs = 10_000, spawner: Spawner = localSpawner) {
  dir = await mkdtemp(join(tmpdir(), "majhi-exec-"));
  const folder = dir;
  const exec = execInTask({
    spawner,
    base: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    task: () => ({ folder }) as Task,
    repoMounts: async () => [],
  });
  return exec("ACM-1", folder, command, timeoutMs);
}

describe("the package store of a hand-off check", () => {
  it("points pnpm at the shared store outside the worktree and mounts it", async () => {
    dir = await mkdtemp(join(tmpdir(), "majhi-exec-"));
    const folder = dir;
    const store = join(tmpdir(), "majhi-home", "cache", "acme", "pnpm-store");
    const seen: { env?: Record<string, string>; mounts?: { path: string }[] | undefined } = {};
    const spawner: Spawner = async (req) => {
      seen.env = req.env;
      seen.mounts = req.mounts;
      return localSpawner(req);
    };
    const exec = execInTask({
      spawner,
      base: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      task: () => ({ folder }) as Task,
      repoMounts: async () => [],
      packages: async () => ({
        mounts: [{ path: join(tmpdir(), "majhi-home", "cache", "acme") }],
        env: { npm_config_store_dir: store, PNPM_STORE_DIR: store },
      }),
    });
    const result = await exec("ACM-1", folder, 'printf %s "$npm_config_store_dir"', 10_000);
    expect(result.output).toBe(store);
    expect(seen.env?.PNPM_STORE_DIR).toBe(store);
    expect(store.startsWith(`${folder}/`)).toBe(false);
    expect(seen.mounts?.map((m) => m.path)).toContain(join(tmpdir(), "majhi-home", "cache", "acme"));
  });
});

describe("running a project's command for the hand-off", () => {
  it("returns the exit code and what it printed, in the worktree", async () => {
    const ok = await run("pwd; echo out; echo err 1>&2");
    expect(ok.code).toBe(0);
    expect(ok.output).toContain("out");
    expect(ok.output).toContain("err");
    expect(ok.output).toContain(dir?.split("/").at(-1));
    const bad = await run("echo broken; exit 3");
    expect(bad).toMatchObject({ code: 3, timedOut: false });
    expect(bad.output).toContain("broken");
  });

  it("stops a command that does not finish, and says so", async () => {
    const started = Date.now();
    const hung = await run("echo started; sleep 30", 400);
    expect(hung.timedOut).toBe(true);
    expect(hung.output).toContain("started");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("gives it a clean environment: nothing of majhi's own, and no secret it prints survives", async () => {
    vi.stubEnv("MAJHI_SECRETS_KEY_SENTINEL", "must-not-reach-a-command");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-must-not-reach-a-command-0000000000");
    const seen = await run("env");
    expect(seen.output).not.toContain("MAJHI_SECRETS_KEY_SENTINEL");
    expect(seen.output).not.toContain("must-not-reach-a-command");
    expect(seen.output).toContain("HOME=/tmp");

    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const leaked = await run(`echo "the token is ${token}"`);
    expect(leaked.output).not.toContain(token);
    expect(leaked.output).toContain("[hidden]");
  });

  it("reports a command majhi could not start as an error, not as a failed test", async () => {
    const res = await run("true", 1_000, async () => {
      throw new Error("the runner is not ready");
    });
    expect(res).toMatchObject({ code: null, error: "the runner is not ready" });
  });

  it("masks every secret in a text and leaves the rest alone", () => {
    const text = `a ghp_${"x9Y8z7W6v5".repeat(4)} b sk-ant-api03-${"q".repeat(30)} c`;
    expect(maskSecrets(text)).toBe("a [hidden] b [hidden] c");
    expect(maskSecrets("nothing here")).toBe("nothing here");
  });
});
