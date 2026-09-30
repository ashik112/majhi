import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { serve } from "@hono/node-server";
import type { McpServerSpec } from "@majhi/acp";
import type { Fact, MemoryEvent } from "@majhi/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
let server: Server | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  server?.closeAllConnections?.();
  server?.close();
  await w?.cleanup();
  w = undefined;
  server = undefined;
});

const text = (res: unknown): string =>
  ((res as { content: { text: string }[] }).content[0]?.text ?? "") as string;
const failed = (res: unknown): boolean => (res as { isError?: boolean }).isError === true;

/** Acme (project acme-api) and Globex (project globex-web), each with a builder whose sessions are recorded. */
async function world() {
  w = await taskWorld();
  const { h } = w;
  const must = async (name: Parameters<typeof h.cmd>[0], body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
    return res.body;
  };
  await must("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
  await must("accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" });
  await must("agents.create", {
    id: "globex-builder",
    frontmatter: { scope: "globex", role: "Builder", account: "claude-globex", perms: ["edit"] },
    instructions: "Build things.\n",
  });
  await w.addRepo("web");
  await must("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web", aliases: ["web"] });

  server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  const s = server;
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;

  const servers: Record<string, McpServerSpec[]> = {};
  h.runtime.onSession = (session, start) => {
    servers[basename(start.account.home)] = start.mcpServers ?? [];
    // The turn stays open, so the session's tokens stay valid until the test ends.
    session.script = async (turn) => {
      await turn.untilCancelled();
      return "cancelled";
    };
  };
  const create = async (body: string) =>
    (await must("tasks.create", { text: body, start: true })) as { id: string };
  const memoryOf = async (account: string): Promise<Client> => {
    for (let i = 0; i < 600 && servers[account] === undefined; i++)
      await new Promise((r) => setTimeout(r, 5));
    const spec = servers[account]?.find((x) => x.name === "majhi-memory");
    if (spec === undefined) throw new Error(`no majhi-memory on ${account}`);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers },
      }) as Transport,
    );
    clients.push(client);
    return client;
  };
  const taskMd = (id: string) => readFile(`${w?.taskDir(id)}/TASK.md`, "utf8");
  return { h, must, create, memoryOf, taskMd };
}

describe("majhi-memory", () => {
  it("shows an agent only global, its org and that org's projects, and never another org's facts", async () => {
    const { h, create, memoryOf } = await world();
    const memory = h.majhi.services.memory;
    await memory.add(
      { text: "Globex web builds use the red cluster", scope: "org:globex", pinned: false },
      { kind: "owner" },
    );
    await memory.add(
      { text: "Acme builds use the blue cluster", scope: "org:acme", pinned: false },
      { kind: "owner" },
    );
    await memory.add({ text: "Everyone signs commits", scope: "global", pinned: false }, { kind: "owner" });
    await memory.add(
      { text: "Acme api uses pnpm for builds", scope: "project:acme-api", pinned: false },
      { kind: "owner" },
    );
    await create("fix the health check in web");
    await create("fix the health check in api");
    const globex = await memoryOf("claude-globex");
    const acme = await memoryOf("claude-acme");
    expect((await globex.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "list_recent",
      "propose",
      "recall",
    ]);

    const seen = text(
      await globex.callTool({ name: "recall", arguments: { query: "builds cluster pnpm signs" } }),
    );
    expect(seen).toContain("red cluster");
    expect(seen).toContain("Everyone signs commits");
    expect(seen).not.toContain("blue");
    expect(seen).not.toContain("pnpm");
    expect(text(await globex.callTool({ name: "list_recent", arguments: {} }))).not.toContain("Acme");

    // Asking for another org's scope by name is refused, for reading and for proposing.
    for (const scope of ["org:acme", "project:acme-api"]) {
      expect(failed(await globex.callTool({ name: "recall", arguments: { query: "builds", scope } }))).toBe(
        true,
      );
      expect(failed(await globex.callTool({ name: "list_recent", arguments: { scope } }))).toBe(true);
      expect(
        failed(await globex.callTool({ name: "propose", arguments: { text: "Builds are fine", scope } })),
      ).toBe(true);
    }
    expect(memory.list({ status: "pending" })).toHaveLength(0);

    // An org's project other than the task's repo is fine for its own agents.
    expect(
      text(await acme.callTool({ name: "recall", arguments: { query: "pnpm", scope: "project:acme-api" } })),
    ).toContain("pnpm");
  });

  it("defaults a proposal to the task's org and leaves it pending", async () => {
    const { h, create, memoryOf } = await world();
    const task = await create("fix the health check in api");
    const acme = await memoryOf("claude-acme");
    const res = await acme.callTool({
      name: "propose",
      arguments: { text: "The api needs Node 22 to build" },
    });
    expect(failed(res)).toBe(false);
    const [fact] = h.majhi.services.memory.list({ task: task.id });
    expect(fact).toMatchObject({ scope: "org:acme", status: "pending", agent: "acme-builder" });
  });
});

describe("Done when", () => {
  it("a fact proposed in one task is approved and then in the next task's TASK.md, in the same repo only", async () => {
    const { h, must, create, memoryOf, taskMd } = await world();
    const one = await create("document the install steps in api");
    const acme = await memoryOf("claude-acme");
    const fact = "Use pnpm, not npm, to install packages in acme-api";
    const proposed = await acme.callTool({
      name: "propose",
      arguments: { text: fact, scope: "project:acme-api" },
    });
    expect(text(proposed)).toContain("pending");
    const [pending] = (await must("memory.list", { task: one.id })) as Fact[];
    expect(pending).toMatchObject({ text: fact, status: "pending", scope: "project:acme-api" });

    // Not approved yet: a second task in the repo does not get it.
    const early = await create("update the install steps in api");
    expect(await taskMd(early.id)).not.toContain("## Memory");

    const approved = (await must("memory.approve", { id: pending?.id })) as Fact;
    expect(approved).toMatchObject({ status: "active", decided_by: "owner" });
    const events = (await must("memory.events", { task: one.id })) as MemoryEvent[];
    expect(events.map((e) => e.action).sort()).toEqual(["approved", "proposed"]);

    const two = await create("check the install steps in api");
    const md = await taskMd(two.id);
    expect(md).toContain("## Memory");
    expect(md).toContain(`- ${fact} (project acme-api)`);
    const hits = (await must("memory.search", { query: "install packages" })) as { fact: Fact }[];
    expect(hits[0]?.fact.use_count).toBe(1);

    // A task in another org does not get it, in TASK.md or from the tool.
    const other = await create("check the install steps in web");
    expect(await taskMd(other.id)).not.toContain("pnpm");
    const globex = await memoryOf("claude-globex");
    expect(
      text(await globex.callTool({ name: "recall", arguments: { query: "install packages pnpm" } })),
    ).toBe("No facts found.");
    expect(h.majhi.services.memory.get(approved.id)?.use_count).toBe(1);
  });
});
