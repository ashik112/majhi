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
function flow(levels: Record<string, string> = { acme: "routine", globex: "routine" }) {
  const items = new Map<string, RoomItem>();
  const byTask = new Set<string>();
  const logged: { task: string; kind: string; by: string }[] = [];
  const room = {
    post: (task: string, id: string, payload: object) => {
      items.set(id, { id, task, seq: items.size, at: "2026-10-04T12:00:00Z", ...payload } as RoomItem);
    },
    get: (_task: string, id: string) => items.get(id),
  } as unknown as RoomService;
  const orgOf = (task: string) => (task.startsWith("GLX") ? "globex" : "acme");
  const store = {
    tasks: {
      get: (task: string) => ({
        org: orgOf(task),
        folder: `/Users/owner/tasks/${task}`,
        repos: [
          {
            project: "api",
            branch: "fix/login",
            base: "main",
            worktree: `/Users/owner/tasks/${task}/api`,
          },
        ],
      }),
    },
    permissions: {
      allow: (task: string, key: string) => byTask.add(`${task}|${key}`),
      allowed: (task: string, key: string) => byTask.has(`${task}|${key}`),
      log: (row: { task: string; kind: string; by: string }) => logged.push(row),
    },
  } as unknown as Store;
  const live = { set: () => {} } as unknown as RunLive;
  const added: string[] = [];
  const connections = {
    addTool: async (id: string, tool: string, as: "allow" | "read") => {
      added.push(`${as}:${id}.${tool}`);
    },
  };
  const rules: { org: string; kind: string }[] = [];
  const config = {
    settings: async () => ({
      autonomy: { orgs: Object.fromEntries(Object.entries(levels).map(([o, level]) => [o, { level }])) },
      policy: { rules },
    }),
    setSettings: async (patch: { policy: { rules: typeof rules } }) => {
      rules.splice(0, rules.length, ...patch.policy.rules);
    },
  } as unknown as ConfigService;
  const permissions = new PermissionFlow(
    { store, room, connections, config },
    live,
    () => new Date("2026-10-04T12:00:00Z"),
  );
  const ask = (title: string, over: Partial<PermissionAsk> = {}): PermissionAsk =>
    ({
      title,
      kind: "other",
      options: [
        { id: "once", name: "Yes", kind: "allow_once" },
        { id: "task", name: "Allow for this task", kind: "allow_always" },
        { id: "no", name: "Deny", kind: "reject_once" },
      ],
      ...over,
    }) as PermissionAsk;
  const shell = (line: string): PermissionAsk => ask(line, { kind: "execute", command: line });
  const runOf = (task: string, extra: object = {}): AgentRun =>
    ({
      task,
      agent: "acme-claude",
      runId: 4,
      permSeq: 0,
      perms: [],
      pending: new Map(),
      live: { status: "working" },
      ...extra,
    }) as unknown as AgentRun;
  const held = (task: string): AgentRun =>
    runOf(task, {
      connections: {
        gate: [{ id: "acme-obs", type: "mcp", server: "acme-obs", allow: [] }],
        uses: [{ id: "acme-obs", name: "Acme Observability" }],
        secrets: [],
      },
    });
  return { permissions, runOf, ask, shell, items, held, added, rules, logged };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const signal = new AbortController().signal;

describe("what the level lets through without a card", () => {
  /** [the request, whether it asks at Ask me, whether it asks at Routine, whether it asks at Full] */
  const table: [string, boolean, boolean, boolean][] = [
    ["cd api && pnpm test", false, false, false],
    ["pnpm install && pnpm build", false, false, false],
    ["docker pull postgres:16-alpine", false, false, false],
    ["git commit -am 'fix login'", false, false, false],
    ["git push origin fix/login", true, false, false],
    ["git push -u origin HEAD", true, false, false],
    ["gh pr create --draft --fill", true, false, false],
    ["gh pr create --fill", true, true, true],
    ["git push origin main", true, true, false],
    ["gh pr merge 12", true, true, false],
    ["git push origin --delete fix/login", true, true, true],
    ["rm -rf /Users/owner/Documents", true, true, true],
    ["cat /Users/owner/.ssh/id_ed25519", true, true, true],
  ];

  it.each(table)(
    "%s asks at Ask me: %s, at Routine: %s, at Full: %s",
    async (line, atAsk, atRoutine, atFull) => {
      const outcome = async (level: string) => {
        const t = flow({ acme: level });
        const run = t.runOf("ACM-8");
        void t.permissions.ask(run, t.shell(line), signal);
        await tick();
        return run.pending.size === 1;
      };
      expect([await outcome("ask"), await outcome("routine"), await outcome("full")]).toEqual([
        atAsk,
        atRoutine,
        atFull,
      ]);
    },
  );

  it("leaves no room item for what stays inside the task, and logs it once a minute per kind", async () => {
    const t = flow();
    const run = t.runOf("ACM-8");
    for (const line of ["pnpm test", "pnpm lint", "cd api"]) {
      expect(await t.permissions.ask(run, t.shell(line), signal)).toBe("once");
    }
    expect(await t.permissions.ask(run, t.ask("Read a.ts", { kind: "read" }), signal)).toBe("once");
    expect(t.items.size).toBe(0);
    // Three commands in the same minute are one row; the read is another kind of action.
    expect(t.logged.map((l) => [l.kind, l.by])).toEqual([
      ["execute", "rule"],
      ["read", "rule"],
    ]);
  });
});

describe("Always", () => {
  const push = "git push origin main";

  it("keeps one rule for the workspace and the kind, and covers the next task there and no other workspace", async () => {
    const t = flow();
    const first = t.runOf("ACM-8");
    const asking = t.permissions.ask(first, t.shell(push), signal);
    await tick();
    expect(t.items.get("perm:4:1")).toMatchObject({
      state: "pending",
      risk: "merge-main",
      options: [{ id: "once" }, { id: "majhi:task" }, { id: "majhi:always" }, { id: "no" }],
    });
    // The captain never answers it: a card is there because the level does not cover it.
    expect(() => t.permissions.answer(first, "ACM-8", "perm:4:1", "majhi:always", true)).toThrow(/owner/);
    t.permissions.answer(first, "ACM-8", "perm:4:1", "majhi:always");
    expect(await asking).toBe("once");
    await tick();
    expect(t.rules).toEqual([{ org: "acme", kind: "merge-main" }]);

    // The next task of the same workspace goes ahead.
    const next = t.runOf("ACM-9");
    expect(await t.permissions.ask(next, t.shell(push), signal)).toBe("once");
    expect(t.items.get("perm:4:1")).toMatchObject({ state: "auto" });

    // Another workspace asks, and so does another kind of action in this one.
    const other = t.runOf("GLX-1");
    void t.permissions.ask(other, t.shell(push), signal);
    await tick();
    expect(other.pending.size).toBe(1);
    const message = t.runOf("ACM-10");
    void t.permissions.ask(message, t.shell("gh pr create --fill"), signal);
    await tick();
    expect(message.pending.size).toBe(1);
  });

  it("is never offered for a kind that always asks, and never for the agent's own allow always", async () => {
    const t = flow();
    const run = t.runOf("ACM-8");
    void t.permissions.ask(run, t.shell("rm -rf /Users/owner/Documents"), signal);
    await tick();
    expect(t.items.get("perm:4:1")).toMatchObject({
      risk: "delete-outside",
      options: [{ id: "once" }, { id: "no" }],
    });
  });
});

describe("a connection's MCP tool write", () => {
  const sync = "mcp__acme-obs__sync_data";

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

  it("refuses the captain every choice, and saves Always allow and It only reads for the owner", async () => {
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
