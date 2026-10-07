import type { McpServerSpec } from "@majhi/acp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTools, remoteTransport } from "../connections/mcp-client.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { FakeAuthServer, FakeMcpServer, fakeService } from "./testing/fakes.ts";

/**
 * Connect, end to end through majhi's own commands and callback route: the owner connects a
 * workspace to a fake MCP server, and the agent sessions of that workspace get the server with a
 * header the server accepts. A session of another workspace never gets it.
 */
describe("a connected service reaches only its own workspace's agent sessions", () => {
  let w: World;
  let auth: FakeAuthServer;
  let mcp: FakeMcpServer;

  const must = async (name: string, body: unknown) => {
    const res = await w.h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  /** The owner's whole path: Connect, the service's page, the callback in the browser. */
  const connectWorkspace = async (org: string, account: string): Promise<string> => {
    const flow = (await must("connect.start", { org, service: "fakesvc" })) as { flow: string; url: string };
    // No host helper in a test, so majhi shows the address instead of opening it.
    expect(flow.url).toContain(auth.url);
    const back = new URL(auth.approve(flow.url, { account }));
    const page = await w.h.majhi.app.request(`${back.pathname}${back.search}`);
    expect(page.status).toBe(200);
    const done = (await must("connect.flow", { flow: flow.flow })) as { state: string; connection: string };
    expect(done.state).toBe("connected");
    return done.connection;
  };

  /** The MCP servers of the session that started last. */
  const lastServers = () => (w.h.runtime.starts.at(-1)?.mcpServers ?? []) as McpServerSpec[];

  beforeEach(async () => {
    auth = new FakeAuthServer();
    await auth.start();
    mcp = new FakeMcpServer(auth);
    await mcp.start();
    w = await taskWorld({ agent: { connections: ["fakesvc"] }, connectCatalog: [fakeService(mcp.url)] });
    await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
    await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
    await w.addRepo("web");
    await must("projects.register", {
      id: "globex-web",
      org: "globex",
      path: "~/Work/web",
      aliases: ["web"],
    });
  });

  afterEach(async () => {
    await w.cleanup();
    await auth.stop();
    await mcp.stop();
  });

  it("gives the workspace's agent the server with a valid header, and another workspace's agent nothing of it", async () => {
    const acme = await connectWorkspace("acme", "maria@acme.example");
    const globex = await connectWorkspace("globex", "bob@globex.example");
    expect([acme, globex]).toEqual(["fakesvc", "fakesvc-2"]);
    await must("agents.create", {
      id: "globex-builder",
      frontmatter: {
        scope: "globex",
        role: "Builder",
        account: "claude-globex",
        where: ["globex", "acme"],
        perms: ["edit", "shell"],
        // It even lists Acme's connection: an org agent never gets another org's.
        connections: [globex, acme],
      },
      instructions: "Build.\n",
    });

    // Acme's agent, in an Acme task.
    const acmeTask = (await must("tasks.create", {
      text: "check the issues, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(acmeTask.id);
    const server = lastServers().find((s) => s.name === "fakesvc");
    expect(server?.type).toBe("http");
    const headers = (server as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toMatch(/^Bearer at-/);
    // The header is one the server accepts, for Acme's account.
    const token = headers.Authorization?.replace("Bearer ", "") ?? "";
    expect(auth.accessOf(token)?.account).toBe("maria@acme.example");
    const tools = await listTools(remoteTransport(mcp.url, headers), 10_000);
    expect(tools.map((t) => t.name)).toEqual(["list_issues", "create_issue"]);
    expect(lastServers().map((s) => s.name)).not.toContain("fakesvc-2");

    // Globex's agent, in a Globex task, gets Globex's account, not Acme's.
    const globexTask = (await must("tasks.create", {
      text: "check the issues, repo web",
      repos: [{ project: "globex-web" }],
      kind: "ops",
      team: ["globex-builder"],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(globexTask.id);
    const own = lastServers();
    expect(own.map((s) => s.name)).toEqual(expect.arrayContaining(["fakesvc-2"]));
    expect(own.map((s) => s.name)).not.toContain("fakesvc");
    const bob = (own.find((s) => s.name === "fakesvc-2") as { headers: Record<string, string> }).headers;
    expect(auth.accessOf(bob.Authorization?.replace("Bearer ", "") ?? "")?.account).toBe(
      "bob@globex.example",
    );
    expect(bob.Authorization).not.toBe(headers.Authorization);

    // The same agent in the other workspace's task: Globex's agent working in Acme gets neither.
    const crossTask = (await must("tasks.create", {
      text: "look at the api issues, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      team: ["globex-builder"],
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(crossTask.id);
    const cross = w.h.runtime.starts.at(-1);
    const crossNames = (cross?.mcpServers ?? []).map((s) => s.name);
    expect(crossNames).not.toContain("fakesvc");
    expect(crossNames).not.toContain("fakesvc-2");
    expect(JSON.stringify(cross)).not.toContain(token);
  });

  it("never puts the refresh token or the access token in a run's environment or mounts", async () => {
    await connectWorkspace("acme", "maria@acme.example");
    const task = (await must("tasks.create", {
      text: "check the issues, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      start: true,
    })) as { id: string };
    await w.h.majhi.services.runs.idle(task.id);
    const start = w.h.runtime.starts.at(-1);
    const grant = await w.h.majhi.services.connect.ensureFresh("fakesvc");
    const refresh = grant?.tokens.refreshToken ?? "";
    expect(refresh).toMatch(/^rt-/);
    const env = JSON.stringify({ env: start?.env, mounts: start?.mounts });
    expect(env).not.toContain(refresh);
    expect(env).not.toContain(grant?.tokens.accessToken ?? "");
    // The refresh token is not in the MCP server spec either, only the access token as a header.
    expect(JSON.stringify(start?.mcpServers)).not.toContain(refresh);
  });

  it("only the owner starts, answers or ends a connection; an agent is refused", async () => {
    const agent = { actor: { kind: "agent", id: "acme-builder" } };
    const refused = await w.h.cmd("connect.start", { org: "acme", service: "fakesvc" }, agent);
    expect(refused.status).toBe(409);
    await connectWorkspace("acme", "maria@acme.example");
    const gone = await w.h.cmd("connect.disconnect", { connection: "fakesvc" }, agent);
    expect(gone.status).toBe(409);
    const kept = (await must("connect.status", { org: "acme" })) as unknown[];
    expect(kept).toHaveLength(1);
  });
});
