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
    task: () => ({ folder, repos: [] }) as unknown as Task,
    repoMounts: async () => [],
  });
  return exec("ACM-1", folder, command, timeoutMs);
}

/** Runs `env` with a workspace store and a tools folder, as the check is given them. */
async function runWithWorld(command: string) {
  dir = await mkdtemp(join(tmpdir(), "majhi-exec-"));
  const folder = dir;
  const exec = execInTask({
    spawner: localSpawner,
    base: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    task: () => ({ folder }) as Task,
    repoMounts: async () => [],
    packages: async () => ({ mounts: [], env: { npm_config_cache: "/store/npm" }, home: "/store/home" }),
    tools: async () => ({ mounts: [], env: { MAJHI_TOOLS: "/tools/acme" } }),
  });
  return exec("ACM-1", folder, command, 10_000);
}

describe("running a project's command for the hand-off", () => {
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

  it("runs with the workspace's package caches, its tools on PATH and a home of its own, never the account's", async () => {
    const seen = await runWithWorld("env");
    expect(seen.output).toContain("HOME=/store/home");
    expect(seen.output).toContain("npm_config_cache=/store/npm");
    expect(seen.output).toContain("MAJHI_TOOLS=/tools/acme");
    expect(seen.output).toMatch(/^PATH=\/tools\/acme\/bin:/m);
  });

  it("keeps the whole output for the log, masked, while the card's end of it stays short", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const out = await run(
      `echo "token ${token}"; i=1; while [ $i -le 5000 ]; do echo "line $i of the run"; i=$((i+1)); done; echo "done" >&2`,
    );
    expect(out.log).toContain("line 1 of the run\n");
    expect(out.log).toContain("line 5000 of the run");
    expect(out.log).not.toContain(token);
    expect(out.log).toContain("token [hidden]");
    expect(out.output.length).toBeLessThanOrEqual(64 * 1024);
    expect(out.output.trimEnd().endsWith("done")).toBe(true);
    expect(out.cut).toBeUndefined();
  });

  it("cuts an output past the cap in the middle and says so", async () => {
    const out = await run(
      'i=1; while [ $i -le 25000 ]; do echo "row $i xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"; i=$((i+1)); done',
      60_000,
    );
    expect(out.cut).toBeGreaterThan(0);
    expect(out.log.startsWith("row 1 ")).toBe(true);
    expect(out.log).toContain("[majhi: output cut at 0.95 MB,");
    expect(out.log.trimEnd().endsWith("row 25000 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toBe(true);
  });

  it("masks every secret in a text and leaves the rest alone", () => {
    const text = `a ghp_${"x9Y8z7W6v5".repeat(4)} b sk-ant-api03-${"q".repeat(30)} c`;
    expect(maskSecrets(text)).toBe("a [hidden] b [hidden] c");
    expect(maskSecrets("nothing here")).toBe("nothing here");
  });
});
