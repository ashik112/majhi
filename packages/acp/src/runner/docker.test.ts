import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpawnRequest } from "../spawn.ts";
import { dockerRunArgs, MountRefused, type RunnerConfig, runMounts } from "./docker.ts";

let root: string;
let home: string;
let majhiHome: string;
let cfg: RunnerConfig;

const accountFolder = (id: string) => join(majhiHome, "accounts", id);
const agentHome = (org: string, id: string) => join(majhiHome, "agent-homes", org, id);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "majhi-runner-"));
  home = join(root, "Users", "owner");
  majhiHome = join(home, ".majhi");
  await mkdir(accountFolder("claude-acme"), { recursive: true });
  await mkdir(accountFolder("claude-globex"), { recursive: true });
  await writeFile(join(accountFolder("claude-acme"), ".credentials.json"), "{}");
  await writeFile(join(accountFolder("claude-acme"), ".claude.json"), "{}");
  await mkdir(agentHome("acme", "claude-acme"), { recursive: true });
  await mkdir(agentHome("globex", "claude-acme"), { recursive: true });
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
      HOME: agentHome("acme", "claude-acme"),
      ANTHROPIC_API_KEY: "sk-test-value-never-in-argv",
    },
    cwd: join(home, "Work", ".majhi", "ACM-1"),
    account: {
      tool: "claude",
      home: agentHome("acme", "claude-acme"),
      accountHome: accountFolder("claude-acme"),
    },
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
  it("mounts only the task folder, the repo's .git (config and hooks read-only), the run's own workspace home and that account's sign-in file", () => {
    const args = dockerRunArgs(request(), cfg, "majhi-run-test");
    const repo = join(home, "Work", "api", ".git");
    const own = agentHome("acme", "claude-acme");
    expect(mountArgs(args)).toEqual([
      `type=bind,source=${join(home, "Work", ".majhi", "ACM-1")},target=${join(home, "Work", ".majhi", "ACM-1")}`,
      `type=bind,source=${own},target=${own}`,
      `type=bind,source=${repo},target=${repo}`,
      `type=bind,source=${join(repo, "config")},target=${join(repo, "config")},readonly`,
      `type=bind,source=${join(repo, "hooks")},target=${join(repo, "hooks")},readonly`,
      `type=bind,source=${join(accountFolder("claude-acme"), ".credentials.json")},target=${join(own, ".credentials.json")}`,
    ]);
    const joined = args.join(" ");
    expect(joined).not.toContain("secrets.key");
    expect(joined).not.toContain("claude-globex");
    expect(joined).not.toContain("docker.sock");
    expect(joined).not.toContain(".claude.json");
    expect(mountArgs(args).some((m) => m.includes(`source=${majhiHome},`))).toBe(false);
    expect(mountArgs(args).some((m) => m.includes(`source=${accountFolder("claude-acme")},`))).toBe(false);
  });

  const own = () => agentHome("acme", "claude-acme");
  it.each([
    ["another workspace's home", () => request({ mounts: [{ path: agentHome("globex", "claude-acme") }] })],
    [
      "another workspace's home, read-only",
      () => request({ mounts: [{ path: agentHome("globex", "claude-acme"), readOnly: true }] }),
    ],
    ["every agent home at once", () => request({ mounts: [{ path: join(majhiHome, "agent-homes") }] })],
    ["the account folder", () => request({ mounts: [{ path: accountFolder("claude-acme") }] })],
    ["another account's folder", () => request({ mounts: [{ path: accountFolder("claude-globex") }] })],
    ["every account folder at once", () => request({ mounts: [{ path: join(majhiHome, "accounts") }] })],
    [
      "another file of the account folder",
      () => request({ mounts: [{ path: join(accountFolder("claude-acme"), ".claude.json") }] }),
    ],
    [
      "the sign-in file at another place in the home",
      () =>
        request({
          mounts: [
            {
              path: join(accountFolder("claude-acme"), ".credentials.json"),
              target: join(own(), "settings.json"),
            },
          ],
        }),
    ],
    [
      "the sign-in file as a read-only file of the task folder",
      () =>
        request({
          mounts: [
            {
              path: join(accountFolder("claude-acme"), ".credentials.json"),
              target: join(home, "Work", ".majhi", "ACM-1", ".claude", "skills"),
              readOnly: true,
            },
          ],
        }),
    ],
    [
      "the account folder as the session's own home",
      () => request({ account: { tool: "claude", home: accountFolder("claude-acme") } }),
    ],
    [
      "another workspace's home as the session's own, with this account's sign-in",
      () =>
        request({
          account: {
            tool: "claude",
            home: join(majhiHome, "agent-homes", "acme", "claude-globex"),
            accountHome: accountFolder("claude-acme"),
          },
        }),
    ],
    [
      "a home that climbs out of agent-homes",
      () =>
        request({
          account: {
            tool: "claude",
            home: join(majhiHome, "agent-homes", "..", "accounts", "claude-acme"),
            accountHome: accountFolder("claude-acme"),
          },
        }),
    ],
  ])("refuses %s", (_name, make) => {
    expect(() => runMounts(make(), cfg)).toThrow(MountRefused);
  });

  it("gives an API-key account or a missing sign-in file no sign-in mount, and a probe its account folder without one", () => {
    const targets = (req: SpawnRequest) => runMounts(req, cfg).map((m) => m.target);
    expect(targets(request())).toContain(join(own(), ".credentials.json"));
    expect(
      targets(
        request({
          account: {
            tool: "claude",
            home: own(),
            accountHome: accountFolder("claude-acme"),
            apiKey: "sk-test",
          },
        }),
      ),
    ).not.toContain(join(own(), ".credentials.json"));
    expect(
      targets(
        request({
          account: {
            tool: "claude",
            home: agentHome("globex", "claude-globex"),
            accountHome: accountFolder("claude-globex"),
          },
        }),
      ),
    ).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const probe = runMounts(
      request({
        accountFolder: true,
        mounts: [],
        scratch: true,
        account: { tool: "claude", home: accountFolder("claude-acme") },
      }),
      cfg,
    );
    expect(probe.map((m) => m.path)).toEqual([accountFolder("claude-acme")]);
  });
});
