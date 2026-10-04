import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAdapter } from "../testing/index.ts";
import type { AccountRuntime } from "./index.ts";
import { mcpValuesToEnv } from "./mcp-env.ts";
import { dockerRunArgs, type RunnerConfig } from "./runner/docker.ts";
import { type McpServerSpec, type StdioServerSpec, startSession } from "./session.ts";
import { localSpawner, type SpawnRequest } from "./spawn.ts";

const ROOM_TOKEN = "room-token-AAAA1111";
const DO_TOKEN = "dop_v1_BBBB2222";
const STDIO_SECRET = "pg-password-CCCC3333";

const room: McpServerSpec = {
  type: "http",
  name: "majhi-room",
  url: "http://majhi-server:7070/mcp/room",
  headers: { Authorization: `Bearer ${ROOM_TOKEN}` },
};
const remote: McpServerSpec = {
  type: "http",
  name: "acme-do",
  url: "https://example.test/mcp",
  headers: { Authorization: `Bearer ${DO_TOKEN}`, "X-Empty": "" },
};
const db: StdioServerSpec = {
  type: "stdio",
  name: "acme-db",
  command: "sh",
  args: ["-c", "exec db-mcp"],
  env: { PGPASSWORD: STDIO_SECRET },
};
const servers = [room, remote, db];

describe("mcpValuesToEnv", () => {
  it("leaves no secret value in the servers, which are what a CLI puts on its command line", () => {
    const out = mcpValuesToEnv(servers);
    const argvForm = JSON.stringify({ mcpServers: out.servers });
    for (const secret of [ROOM_TOKEN, DO_TOKEN, STDIO_SECRET]) expect(argvForm).not.toContain(secret);
    expect(Object.values(out.env).sort()).toEqual(
      [`Bearer ${ROOM_TOKEN}`, `Bearer ${DO_TOKEN}`, STDIO_SECRET].sort(),
    );
  });

  it("points each value at its own variable, keeps empty values and leaves commands alone", () => {
    const out = mcpValuesToEnv(servers);
    const [first, second, third] = out.servers;
    if (first?.type === "stdio" || first === undefined) throw new Error("expected a remote server");
    expect(first.headers.Authorization).toBe("${MAJHI_MCP_0_H0}");
    expect(out.env.MAJHI_MCP_0_H0).toBe(`Bearer ${ROOM_TOKEN}`);
    if (second?.type === "stdio" || second === undefined) throw new Error("expected a remote server");
    expect(second.headers["X-Empty"]).toBe("");
    if (third?.type !== "stdio") throw new Error("expected a stdio server");
    expect(third.env.PGPASSWORD).toBe("${MAJHI_MCP_2_E0}");
    expect(third.command).toBe("sh");
    expect(third.args).toEqual(["-c", "exec db-mcp"]);
  });
});

describe("a session", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "majhi-mcp-env-"));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  async function spawnedRequest(tool: "claude" | "codex"): Promise<SpawnRequest> {
    let seen: SpawnRequest | undefined;
    const account: AccountRuntime = { tool, home: join(root, "home") };
    const session = await startSession({
      account,
      options: {
        base: { PATH: process.env.PATH ?? "/usr/bin" },
        adapters: { [tool]: fakeAdapter(tool, { signedIn: true }) },
        spawner: async (req) => {
          seen = req;
          return localSpawner(req);
        },
      },
      cwd: root,
      mcpServers: servers,
    });
    await session.close();
    if (seen === undefined) throw new Error("nothing was spawned");
    return seen;
  }

  it("starts a Claude adapter with no token on its command line and the values in its environment", async () => {
    const req = await spawnedRequest("claude");
    const argv = [req.command.command, ...req.command.args].join(" ");
    for (const secret of [ROOM_TOKEN, DO_TOKEN, STDIO_SECRET]) expect(argv).not.toContain(secret);
    expect(req.env.MAJHI_MCP_0_H0).toBe(`Bearer ${ROOM_TOKEN}`);
    expect(req.env.MAJHI_MCP_2_E0).toBe(STDIO_SECRET);
  });

  it("leaves Codex alone: it keeps MCP headers in its own memory", async () => {
    const req = await spawnedRequest("codex");
    expect(Object.keys(req.env).filter((k) => k.startsWith("MAJHI_MCP_"))).toEqual([]);
  });
});

describe("the container of a run", () => {
  const cfg: RunnerConfig = {
    image: "majhi-runner:dev",
    network: "majhi-runners",
    user: "501:20",
    cliEnv: { PATH: "/usr/bin" },
    majhiHome: "/Users/owner/.majhi",
    protectedPaths: [],
  };
  const req: SpawnRequest = {
    command: { command: "claude-agent-acp", args: [] },
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/owner/.majhi/accounts/claude-acme",
      MAJHI_MCP_0_H0: `Bearer ${ROOM_TOKEN}`,
      DIGITALOCEAN_ACCESS_TOKEN: DO_TOKEN,
    },
    cwd: "/Users/owner/Work/.majhi/ACM-1",
    task: "ACM-1",
  };

  it("passes variables to docker by name only, so no value is on a command line", () => {
    const args = dockerRunArgs(req, cfg, "majhi-run-test");
    for (const secret of [ROOM_TOKEN, DO_TOKEN]) expect(args.join(" ")).not.toContain(secret);
    expect(args).toContain("MAJHI_MCP_0_H0");
    expect(args).toContain("DIGITALOCEAN_ACCESS_TOKEN");
  });

  it("has its own process, IPC, UTS and user namespaces: nothing of the host, the server or another task shows", () => {
    const args = dockerRunArgs(req, cfg, "majhi-run-test");
    for (const flag of ["--pid", "--ipc", "--uts", "--userns", "--privileged", "--cap-add"]) {
      expect(args.some((a) => a === flag || a.startsWith(`${flag}=`))).toBe(false);
    }
    expect(args[args.indexOf("--network") + 1]).toBe("majhi-runners");
    expect(args).toContain("--init");
    expect(args).toContain("no-new-privileges");
  });
});
