import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
