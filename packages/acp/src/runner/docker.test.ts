import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../spawn.ts";
import { dockerRunArgs, type RunnerConfig } from "./docker.ts";

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
});
