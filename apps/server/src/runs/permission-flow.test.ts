import type { PermissionAsk } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { ConfigService } from "../config/service.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { RunLive } from "./live.ts";
import { PermissionFlow } from "./permission-flow.ts";
import type { AgentRun } from "./run.ts";

/** A flow over fakes: the room keeps items by id, the store keeps allowances. Only what the flow calls. */
function flow() {
  const items = new Map<string, RoomItem>();
  const allowances = new Set<string>();
  const byTask = new Set<string>();
  const room = {
    post: (task: string, id: string, payload: object) => {
      items.set(id, { id, task, seq: items.size, at: "2026-10-04T12:00:00Z", ...payload } as RoomItem);
    },
    get: (_task: string, id: string) => items.get(id),
  } as unknown as RoomService;
  const store = {
    tasks: { get: () => ({ org: "acme" }) },
    permissions: {
      allow: (task: string, key: string) => {
        allowances.add(key);
        byTask.add(`${task}|${key}`);
      },
      allowed: (task: string, key: string) => byTask.has(`${task}|${key}`),
      log: () => {},
    },
  } as unknown as Store;
  const live = { set: () => {} } as unknown as RunLive;
  const run = {
    task: "ACM-8",
    agent: "acme-claude",
    runId: 4,
    permSeq: 0,
    perms: [],
    pending: new Map(),
    live: { status: "working" },
  } as unknown as AgentRun;
  const added: string[] = [];
  const connections = {
    addTool: async (id: string, tool: string, as: "allow" | "read") => {
      added.push(`${as}:${id}.${tool}`);
    },
  };
  const rules: { agent: string; command: string; org?: string }[] = [];
  const config = {
    settings: async () => ({ policy: { rules } }),
    setSettings: async (patch: { policy: { rules: typeof rules } }) => {
      rules.splice(0, rules.length, ...patch.policy.rules);
    },
  } as unknown as ConfigService;
  const permissions = new PermissionFlow(
    { store, room, connections, config },
    live,
    () => new Date("2026-10-04T12:00:00Z"),
  );
  const ask = (title: string): PermissionAsk =>
    ({
      title,
      kind: "other",
      options: [
        { id: "once", name: "Yes", kind: "allow_once" },
        { id: "task", name: "Allow for this task", kind: "allow_always" },
        { id: "no", name: "Deny", kind: "reject_once" },
      ],
    }) as PermissionAsk;
  const held = (task: string): AgentRun =>
    ({
      ...run,
      task,
      pending: new Map(),
      connections: {
        gate: [{ id: "acme-obs", type: "mcp", server: "acme-obs", allow: [] }],
        uses: [{ id: "acme-obs", name: "Acme Observability" }],
        secrets: [],
      },
    }) as unknown as AgentRun;
  return { permissions, run, ask, allowances, items, held, added, rules };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the captain's Allow for this task", () => {
  it("lets that tool run unasked for the rest of the task, and no other tool of its kind", async () => {
    const { permissions, run, ask, allowances, items } = flow();
    const signal = new AbortController().signal;
    const first = permissions.ask(run, ask("mcp__acme-deploy__release"), signal);
    await tick();
    permissions.answer(run, "ACM-8", "perm:4:1", "task", true);
    expect(await first).toBe("task");
    expect([...allowances]).toEqual(["tool:acme-deploy.release"]);

    const again = await permissions.ask(run, ask("mcp__acme-deploy__release"), signal);
    expect(again).toBe("once");
    expect(items.get("perm:4:2")).toMatchObject({ state: "auto" });

    // Another tool of the same kind still asks.
    void permissions.ask(run, ask("mcp__other__deploy"), signal);
    await tick();
    expect(items.get("perm:4:3")).toMatchObject({ state: "pending" });
  });
});

describe("a connection's MCP tool write", () => {
  const sync = "mcp__acme-obs__sync_data";
  const signal = new AbortController().signal;

  it("offers task and always choices, and Allow in this task covers the next call in the same task only", async () => {
    const { permissions, ask, items, held } = flow();
    const run = held("ACM-8");
    const first = permissions.ask(run, ask(sync), signal);
    expect(items.get("perm:4:1")).toMatchObject({
      state: "pending",
      options: [
        { id: "once" },
        { id: "majhi:task" },
        { id: "majhi:always" },
        { id: "majhi:reads" },
        { id: "no" },
      ],
    });
    permissions.answer(run, "ACM-8", "perm:4:1", "majhi:task");
    // The agent is told the plain Allow once, so its own CLI does not remember anything.
    expect(await first).toBe("once");

    expect(await permissions.ask(run, ask(sync), signal)).toBe("once");
    expect(items.get("perm:4:2")).toMatchObject({ state: "auto" });

    // Another task still asks.
    void permissions.ask(held("ACM-9"), ask(sync), signal);
    expect(items.get("perm:4:1")).toMatchObject({ state: "pending" });
  });

  it("keeps a destructive write to Allow once and Deny", () => {
    const { permissions, ask, items, held } = flow();
    const run = held("ACM-8");
    void permissions.ask(run, ask("mcp__acme-obs__delete_view"), signal);
    expect(items.get("perm:4:1")).toMatchObject({
      options: [{ id: "once" }, { id: "no" }],
      connection: { destructive: true },
    });
    expect(() => permissions.answer(run, "ACM-8", "perm:4:1", "majhi:task")).toThrow();
  });

  it("refuses Always allow and It only reads from the captain, and saves them for the owner", async () => {
    const { permissions, ask, held, added } = flow();
    const run = held("ACM-8");
    void permissions.ask(run, ask(sync), signal);
    expect(() => permissions.answer(run, "ACM-8", "perm:4:1", "majhi:always", true)).toThrow(/owner/);
    expect(() => permissions.answer(run, "ACM-8", "perm:4:1", "majhi:reads", true)).toThrow(/owner/);
    expect(added).toEqual([]);

    permissions.answer(run, "ACM-8", "perm:4:1", "majhi:always");
    void permissions.ask(run, ask(sync), signal);
    permissions.answer(run, "ACM-8", "perm:4:2", "majhi:reads");
    await Promise.resolve();
    expect(added).toEqual(["allow:acme-obs.sync_data", "read:acme-obs.sync_data"]);
  });
});

describe("Always allow on an MCP tool that is not a connection's", () => {
  const tool = "mcp__acme-deploy__release";
  const signal = new AbortController().signal;

  it("is the owner's: the captain cannot pick it, and the owner's pick keeps a rule that lets the next call run", async () => {
    const { permissions, run, ask, items, rules } = flow();
    const first = permissions.ask(run, ask(tool), signal);
    await tick();
    expect(items.get("perm:4:1")).toMatchObject({
      options: [{ id: "once" }, { id: "majhi:always" }, { id: "task" }, { id: "no" }],
    });
    expect(() => permissions.answer(run, "ACM-8", "perm:4:1", "majhi:always", true)).toThrow(
      "Only the owner can make that choice.",
    );
    permissions.answer(run, "ACM-8", "perm:4:1", "majhi:always", false);
    expect(await first).toBe("once");
    await new Promise((r) => setTimeout(r, 0));
    expect(rules).toEqual([{ agent: "acme-claude", command: "tool:acme-deploy.release", org: "acme" }]);

    const again = await permissions.ask({ ...run, pending: new Map() } as AgentRun, ask(tool), signal);
    expect(again).toBe("once");
    expect(items.get("perm:4:2")).toMatchObject({ state: "auto" });
  });
});
