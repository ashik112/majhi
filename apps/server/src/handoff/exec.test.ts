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

  it("masks every secret in a text and leaves the rest alone", () => {
    const text = `a ghp_${"x9Y8z7W6v5".repeat(4)} b sk-ant-api03-${"q".repeat(30)} c`;
    expect(maskSecrets(text)).toBe("a [hidden] b [hidden] c");
    expect(maskSecrets("nothing here")).toBe("nothing here");
  });
});
