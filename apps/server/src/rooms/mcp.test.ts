import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";
import { serve } from "@hono/node-server";
import type { McpServerSpec } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
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

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Acme with a lead (Codex) and the builder, served on a real port; the lead's turns wait for `release`. */
async function world() {
  w = await taskWorld();
  const { h } = w;
  for (const [name, body] of [
    ["accounts.create", { id: "codex-acme", tool: "codex", org: "acme", auth: "login" }],
    [
      "agents.create",
      {
        id: "acme-lead",
        frontmatter: { scope: "acme", role: "Lead", account: "codex-acme", perms: ["edit"] },
        instructions: "Lead.\n",
      },
    ],
  ] as const) {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  }
  server = serve({ fetch: h.majhi.app.fetch, hostname: "127.0.0.1", port: 0 }) as unknown as Server;
  const s = server;
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  h.majhi.services.adminTokens.mcpUrl = `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;

  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const prompts: Record<string, string[]> = {};
  const servers: Record<string, McpServerSpec[]> = {};
  h.runtime.onSession = (session, start) => {
    const agent = basename(start.account.home) === "codex-acme" ? "acme-lead" : "acme-builder";
    servers[agent] = (start.mcpServers ?? []).filter((m): m is McpServerSpec => m.type === "http");
    session.script = async (turn) => {
      const list = prompts[agent] ?? [];
      prompts[agent] = list;
      list.push(turn.text);
      if (agent === "acme-lead" && list.length === 1) await Promise.race([gate, turn.untilCancelled()]);
      turn.emit({ type: "text", messageId: `m${list.length}`, text: "done" });
      return "end_turn";
    };
  };
  const res = await h.cmd("tasks.create", {
    text: "add a health endpoint to api",
    team: ["acme-lead", "acme-builder"],
    start: true,
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await until(() => (prompts["acme-lead"]?.length ?? 0) === 1, "lead turn");
  return { h, prompts, servers, release };
}

async function connect(spec: McpServerSpec | undefined, headers?: Record<string, string>): Promise<Client> {
  if (spec === undefined) throw new Error("no such server on the session");
  const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: headers ?? spec.headers },
  });
  const client = new Client({ name: "test", version: "1" });
  await client.connect(transport as Transport);
  clients.push(client);
  return client;
}

const text = (res: unknown): string =>
  ((res as { content: { text: string }[] }).content[0]?.text ?? "") as string;

describe("majhi-room", () => {
  it("is attached to every team member; majhi-tasks only to the lead", async () => {
    const { h, servers, release } = await world();
    expect(servers["acme-lead"]?.map((s) => s.name).sort()).toEqual([
      "majhi-decide",
      "majhi-memory",
      "majhi-processes",
      "majhi-room",
      "majhi-tasks",
    ]);
    release();
    await h.cmd("room.send", { task: "ACM-1", text: "@acme-builder hello" });
    await until(() => servers["acme-builder"] !== undefined, "builder session");
    expect(servers["acme-builder"]?.map((s) => s.name).sort()).toEqual([
      "majhi-decide",
      "majhi-memory",
      "majhi-processes",
      "majhi-room",
    ]);
  });

  it("reads the room, posts, and hands work to a teammate at once", async () => {
    const { h, servers, prompts, release } = await world();
    const room = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-room"));
    const names = (await room.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["ask", "mention", "post", "read_recent", "record_plan", "uploads_create"]);

    const recent = text(await room.callTool({ name: "read_recent", arguments: { limit: 5 } }));
    expect(recent).toMatch(/^Room of ACM-1, newest first:/);
    expect(recent).toContain("Owner to @acme-lead: add a health endpoint to api");

    expect(text(await room.callTool({ name: "post", arguments: { text: "Starting on the plan." } }))).toBe(
      "Posted.",
    );
    const handed = await room.callTool({
      name: "mention",
      arguments: { agent: "@acme-builder", text: "Please add the route in api." },
    });
    expect(text(handed)).toContain("Handed to @acme-builder");
    // Both may edit api, so the builder waits for the lead's turn to end.
    const live = () => h.majhi.services.room.getLive("ACM-1", "acme-builder");
    await until(() => live()?.nowDoing === "Waiting for @acme-lead to finish in acme-api", "builder waits");
    release();
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder prompt");
    expect(prompts["acme-builder"]?.[0]).toContain("> Please add the route in api.");

    const items = (await h.cmd("room.items", { task: "ACM-1", limit: 100 })).body.items as RoomItem[];
    expect(
      items.some((i) => i.type === "agent" && i.agent === "acme-lead" && i.text === "Starting on the plan."),
    ).toBe(true);
    expect(items.some((i) => i.type === "handoff" && i.via === "tool" && i.to === "acme-builder")).toBe(true);
    expect(h.majhi.services.store.tasks.roomState("ACM-1").agentTurns).toBe(1);

    const self = await room.callTool({ name: "mention", arguments: { agent: "acme-lead", text: "x" } });
    expect(self.isError).toBe(true);
  });

  it("hands a long message over whole, and marks a longer one with a way to read the rest", async () => {
    const { h, servers, prompts, release } = await world();
    const room = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-room"));
    const pad = (n: number) => "x".repeat(n);
    const long = `Problem one: the route.\n${pad(7000)}\nProblem two: the test.\n${pad(7000)}\nProblem three: the docs.`;
    await room.callTool({ name: "mention", arguments: { agent: "acme-builder", text: long } });
    release();
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 1, "builder prompt");
    const whole = prompts["acme-builder"]?.[0] ?? "";
    for (const p of ["Problem one: the route.", "Problem two: the test.", "Problem three: the docs."])
      expect(whole).toContain(`> ${p}`);
    expect(whole).not.toContain("Message cut here");

    // A final reply may be longer than mention accepts: the prompt says where it was cut.
    const longer = `${pad(20_000)}\nProblem four: the tail.`;
    const task = h.majhi.services.store.tasks.get("ACM-1");
    if (task === undefined) throw new Error("no task");
    const item = h.majhi.services.runs.handoff(task, {
      from: "acme-lead",
      to: "acme-builder",
      via: "mention",
      text: longer,
    });
    await until(() => (prompts["acme-builder"]?.length ?? 0) === 2, "second builder prompt");
    const cut = prompts["acme-builder"]?.[1] ?? "";
    expect(cut).not.toContain("Problem four");
    expect(cut).toContain(`first 20000 of ${longer.length} characters`);
    expect(cut).toContain(`read_recent with item "${item.id}"`);

    const rest = text(await room.callTool({ name: "read_recent", arguments: { item: item.id } }));
    expect(rest).toContain("@acme-lead handed to @acme-builder:");
    expect(rest).toContain(longer);
    // read_recent cuts long lines in its list, and names the item that reads whole.
    await room.callTool({ name: "post", arguments: { text: `Notes start.\n${pad(3000)}\nNotes end.` } });
    const list = text(await room.callTool({ name: "read_recent", arguments: { limit: 20 } }));
    const id = /cut; read_recent with item "([^"]+)" reads it whole/.exec(list)?.[1];
    expect(id).toBeDefined();
    const note = text(await room.callTool({ name: "read_recent", arguments: { item: id } }));
    expect(note).toContain(`Notes start.\n${pad(3000)}\nNotes end.`);
    const missing = await room.callTool({ name: "read_recent", arguments: { item: "nope" } });
    expect(missing.isError).toBe(true);
  });

  it("refuses a request without a valid token, and a token after its session ended", async () => {
    const { h, servers, release } = await world();
    const spec = servers["acme-lead"]?.find((s) => s.name === "majhi-room");
    if (spec === undefined) throw new Error("no room server");
    const bad = await fetch(spec.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: "{}",
    });
    expect(bad.status).toBe(401);
    release();
    await h.cmd("tasks.stop", { id: "ACM-1" });
    expect(h.majhi.services.roomAccess.room.size).toBe(0);
    expect(h.majhi.services.roomAccess.tasks.size).toBe(0);
    expect(h.majhi.services.roomAccess.processes.size).toBe(0);
  });
});

describe("majhi-processes", () => {
  it("starts, lists and stops processes of the caller's own task only", async () => {
    const { h, servers, release } = await world();
    const tool = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-processes"));
    expect((await tool.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "list",
      "output",
      "restart",
      "start",
      "stop",
    ]);
    const outside = await tool.callTool({ name: "start", arguments: { command: "true", cwd: "/tmp" } });
    expect(outside.isError).toBe(true);
    expect(text(outside)).toContain("outside the task folder");

    const started = await tool.callTool({ name: "start", arguments: { command: "sleep 30", wait: false } });
    expect(text(started)).toMatch(/^Started p1 `sleep 30` in .*ACM-1: running/);
    expect(h.majhi.services.processes.running("ACM-1").map((p) => p.agent)).toEqual(["acme-lead"]);
    expect(text(await tool.callTool({ name: "list", arguments: {} }))).toContain("p1 `sleep 30`");
    // Another task's processes are out of reach: ids are per task.
    expect((await h.cmd("tasks.create", { text: "tidy api", start: false })).status).toBe(200);
    await h.majhi.services.processes.start({
      task: "ACM-2",
      agent: "acme-lead",
      command: "sleep 31",
      wait: false,
    });
    expect(text(await tool.callTool({ name: "list", arguments: {} }))).not.toContain("sleep 31");
    expect(text(await tool.callTool({ name: "stop", arguments: { id: "p1" } }))).toContain(
      "stopped by the agent",
    );
    expect(h.majhi.services.processes.running("ACM-2")).toHaveLength(1);
    release();
  });
});

describe("majhi-tasks", () => {
  it("splits a task into children with a dependency, after the owner approves", async () => {
    const { h, servers, release } = await world();
    const tasks = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-tasks"));
    expect((await tasks.listTools()).tools.map((t) => t.name).sort()).toEqual([
      "close",
      "create",
      "get",
      "link",
      "list",
      "plan",
      "split",
      "start",
      "update",
      "uploads_create",
    ]);
    const args = {
      task: "ACM-1",
      children: [
        { text: "add the route to api" },
        { text: "add the test to api", dependsOn: [0], when: "ready" },
      ],
      ownerAsked: false,
      reason: "Two steps",
    };
    const waiting = await tasks.callTool({ name: "split", arguments: args });
    expect(text(waiting)).toMatch(/Waiting for the owner/);
    const card = ((await h.cmd("room.items", { task: "ACM-1", limit: 100 })).body.items as RoomItem[]).find(
      (i) => i.type === "approval",
    );
    if (card === undefined) throw new Error("no approval card");
    expect(card).toMatchObject({ command: "tasks.split", state: "pending", agent: "acme-lead" });
    expect((await h.cmd("room.approve", { task: "ACM-1", item: card.id, decision: "approve" })).status).toBe(
      200,
    );

    const child = (await h.cmd("tasks.get", { id: "ACM-3" })).body;
    expect(child.links).toEqual(
      expect.arrayContaining([
        { type: "parent", task: "ACM-1" },
        { type: "depends-on", task: "ACM-2", when: "ready" },
      ]),
    );
    const list = JSON.parse(
      text(await tasks.callTool({ name: "list", arguments: { ownerAsked: false, reason: "look" } })),
    );
    expect(list.map((t: { id: string }) => t.id).sort()).toEqual(["ACM-1", "ACM-2", "ACM-3"]);
    release();
  });

  it("keeps an org agent to its org's tasks", async () => {
    const { h, servers, release } = await world();
    // A task without an org: only root agents may work there.
    expect((await h.cmd("tasks.create", { text: "plan the week", kind: "chat", start: false })).status).toBe(
      200,
    );
    const tasks = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-tasks"));
    const got = await tasks.callTool({
      name: "get",
      arguments: { id: "LOCAL-1", ownerAsked: false, reason: "x" },
    });
    expect(got.isError).toBe(true);
    expect(text(got)).toContain("LOCAL-1 is not in an org @acme-lead works in");
    const list = JSON.parse(
      text(await tasks.callTool({ name: "list", arguments: { ownerAsked: false, reason: "x" } })),
    );
    expect(list.map((t: { id: string }) => t.id)).toEqual(["ACM-1"]);
    const made = await tasks.callTool({
      name: "create",
      arguments: { text: "write the release notes", start: false, ownerAsked: true, reason: "x" },
    });
    expect(made.isError).toBe(true);
    release();
  });
  describe("start", () => {
    const call = (tasks: Client, id: string) =>
      tasks.callTool({ name: "start", arguments: { id, ownerAsked: false, reason: "Next step" } });
    const cards = async (h: Awaited<ReturnType<typeof world>>["h"]) =>
      ((await h.cmd("room.items", { task: "ACM-1", limit: 100 })).body.items as RoomItem[]).filter(
        (i) => i.type === "approval" && i.command === "tasks.start",
      );

    it("starts a subtask at once, with an applied card, a note and an audit row", async () => {
      const { h, servers, release } = await world();
      expect(
        (await h.cmd("tasks.create", { text: "add the route to api", parent: "ACM-1", start: false })).status,
      ).toBe(200);
      const tasks = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-tasks"));
      const res = await call(tasks, "ACM-2");
      expect(res.isError).toBeFalsy();
      const { store, room } = h.majhi.services;
      expect(store.tasks.get("ACM-2")?.status).toBe("running");
      expect(await cards(h)).toMatchObject([{ state: "applied", agent: "acme-lead" }]);
      expect(store.permissions.audit("ACM-2")).toMatchObject([
        { agent: "acme-lead", kind: "tasks.start", title: "Started by @acme-lead from ACM-1", by: "lead" },
      ]);
      room.flush("ACM-2");
      const items = (await h.cmd("room.items", { task: "ACM-2", limit: 100 })).body.items as RoomItem[];
      expect(items.some((i) => i.type === "system" && i.text === "Started by @acme-lead from ACM-1")).toBe(
        true,
      );
      release();
    });

    it("keeps a subtask with an unfinished dependency from starting, and starts it when ready", async () => {
      const { h, servers, release } = await world();
      await h.cmd("tasks.create", { text: "add the route to api", parent: "ACM-1", start: false });
      await h.cmd("tasks.create", {
        text: "add the test to api",
        parent: "ACM-1",
        dependsOn: ["ACM-2"],
        start: false,
      });
      const tasks = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-tasks"));
      const res = await call(tasks, "ACM-3");
      expect(res.isError).toBeFalsy();
      expect(text(res)).toBe("Waiting on ACM-2. It starts by itself when they are done.");
      const { store } = h.majhi.services;
      expect(store.tasks.get("ACM-3")?.status).not.toBe("running");
      expect(store.tasks.startWhenReady("ACM-3")).toBe(true);
      expect(store.permissions.audit("ACM-3")).toMatchObject([{ kind: "tasks.start", by: "lead" }]);
      release();
    });

    it("refuses a task in another org, with no card", async () => {
      const { h, servers, release } = await world();
      const world2 = w;
      if (world2 === undefined) throw new Error("no world");
      for (const [name, body] of [
        ["orgs.create", { id: "globex", name: "Globex", key: "GLX" }],
        ["accounts.create", { id: "claude-globex", tool: "claude", org: "globex", auth: "login" }],
        [
          "agents.create",
          {
            id: "globex-builder",
            frontmatter: { scope: "globex", role: "Builder", account: "claude-globex", perms: ["edit"] },
            instructions: "Build.\n",
          },
        ],
      ] as const) {
        expect((await h.cmd(name, body)).status).toBe(200);
      }
      await world2.addRepo("web");
      await h.cmd("projects.register", {
        id: "globex-web",
        org: "globex",
        path: "~/Work/web",
        aliases: ["web"],
      });
      await h.cmd("orgs.update", { id: "acme", lead_start: "org" });
      const made = await h.cmd("tasks.create", { text: "fix web", team: ["globex-builder"], start: false });
      expect(made.status).toBe(200);
      const tasks = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-tasks"));
      const res = await call(tasks, "GLX-1");
      expect(res.isError).toBe(true);
      expect(h.majhi.services.store.tasks.get("GLX-1")?.status).not.toBe("running");
      expect(await cards(h)).toEqual([]);
      expect(h.majhi.services.store.permissions.audit("GLX-1")).toEqual([]);
      release();
    });

    it("asks the owner instead when the setting is off", async () => {
      const { h, servers, release } = await world();
      await h.cmd("tasks.create", { text: "add the route to api", parent: "ACM-1", start: false });
      expect((await h.cmd("orgs.update", { id: "acme", lead_start: "off" })).status).toBe(200);
      const tasks = await connect(servers["acme-lead"]?.find((s) => s.name === "majhi-tasks"));
      const res = await call(tasks, "ACM-2");
      expect(text(res)).toMatch(/Waiting for the owner/);
      expect(h.majhi.services.store.tasks.get("ACM-2")?.status).not.toBe("running");
      expect(await cards(h)).toMatchObject([{ state: "pending" }]);
      expect(h.majhi.services.store.permissions.audit("ACM-2")).toEqual([]);
      release();
    });
  });
});
