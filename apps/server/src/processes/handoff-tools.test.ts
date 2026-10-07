import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { HandoffRepo } from "../handoff/repo.ts";
import { type ExecResult, type HandoffPorts, HandoffService, type HandoffTask } from "../handoff/service.ts";
import { migrate } from "../store/migrations.ts";
import type { ProcessManager } from "./manager.ts";
import { processesServer } from "./mcp.ts";

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
});

const passed = (): ExecResult => ({
  code: 0,
  timedOut: false,
  output: " Tests  3 passed (3)",
  log: " Tests  3 passed (3)",
  ms: 20,
});

/** Two tasks of two workspaces on one hand-off service, as majhi has them. */
function setup() {
  const db = new Database(":memory:");
  migrate(db);
  const ran: string[] = [];
  const gate = { wait: undefined as Promise<void> | undefined };
  const tasks = new Map<string, HandoffTask>();
  for (const [id, org] of [
    ["ACM-1", "acme"],
    ["GLB-1", "globex"],
  ] as const) {
    tasks.set(id, {
      id,
      title: id,
      brief: "Fix it.",
      org,
      status: "review",
      repos: [{ project: `${org}-api`, worktree: `/work/${id}` }],
    });
  }
  const told: { id: string; text: string }[] = [];
  const ports: HandoffPorts = {
    task: (id) => tasks.get(id),
    heads: async (id) => `${id}@aaa111`,
    ready: async () => ({ ok: true, evidence: "committed" }),
    commands: () => ({ test: "pnpm test" }),
    diff: async () => ({ files: [], commits: [] }),
    exec: async (id, _cwd, command) => {
      ran.push(`${id}: ${command}`);
      await gate.wait;
      return passed();
    },
    review: async () => ({ gaps: [], tokens: 0 }),
    autonomous: () => false,
    modelBlocked: () => undefined,
    tell: async (id, text) => {
      told.push({ id, text });
    },
    hold: () => undefined,
    changed: () => undefined,
  };
  const handoff = new HandoffService(ports, new HandoffRepo(db), {});
  const connect = async (task: string) => {
    // The processes tools are not used here: only the hand-off ones, which never touch them.
    const server = processesServer({ task, agent: "agent" }, {} as unknown as ProcessManager, handoff);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    clients.push(client);
    await client.connect(b);
    return client;
  };
  return { handoff, connect, ran, told, gate };
}

const text = (r: unknown): string => (r as { content: { text: string }[] }).content[0]?.text ?? "";

describe("an agent's own hand-off check", () => {
  it("reads and reruns the check of the task it runs in, and no tool takes another task's id", async () => {
    const w = setup();
    await w.handoff.ensure("ACM-1", { force: false });
    await w.handoff.ensure("GLB-1", { force: false });
    w.ran.length = 0;

    const acme = await w.connect("ACM-1");
    const tools = (await acme.listTools()).tools.find((t) => t.name === "handoff_rerun");
    expect(Object.keys((tools?.inputSchema.properties ?? {}) as object)).toEqual(["step"]);

    expect(text(await acme.callTool({ name: "handoff", arguments: {} }))).toContain("ACM-1@aaa111");
    // Smuggling another task's id in the arguments changes nothing: the token's task is the only one.
    const sneaky = await acme.callTool({ name: "handoff", arguments: { task: "GLB-1" } });
    expect(text(sneaky)).toContain("ACM-1@aaa111");
    expect(text(sneaky)).not.toContain("GLB-1");

    await acme.callTool({ name: "handoff_rerun", arguments: { step: "tests", task: "GLB-1" } });
    await w.handoff.settled();
    expect(w.ran).toEqual(["ACM-1: pnpm test"]);
    // The lead of the asking task is told how it ended; nobody else.
    expect(w.told.map((t) => t.id)).toEqual(["ACM-1"]);
  });

  it("refuses a step that is not one of the four, and does not start a second run while one is going", async () => {
    const w = setup();
    const acme = await w.connect("ACM-1");
    const bad = await acme.callTool({ name: "handoff_rerun", arguments: { step: "deploy" } });
    expect(bad.isError).toBe(true);
    expect(w.ran).toEqual([]);

    let release: () => void = () => undefined;
    w.gate.wait = new Promise<void>((r) => {
      release = r;
    });
    await acme.callTool({ name: "handoff_rerun", arguments: {} });
    await acme.callTool({ name: "handoff_rerun", arguments: {} });
    release();
    await w.handoff.settled();
    expect(w.ran).toEqual(["ACM-1: pnpm test"]);
  });
});
