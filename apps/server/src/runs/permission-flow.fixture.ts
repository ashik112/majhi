import type { PermissionAsk } from "@majhi/acp";
import { CAPTAIN_LANE_BRIEF, type RoomItem } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { DeferredResults } from "../connections/deferred.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { RunLive } from "./live.ts";
import { PermissionFlow } from "./permission-flow.ts";
import type { AgentRun } from "./run.ts";

/** A flow over fakes: the room keeps items by id, the store keeps allowances. Only what the flow calls. */
export function flow(levels: Record<string, string> = { acme: "routine", globex: "routine" }) {
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
    room: {
      pendingPermissions: () =>
        [...items.values()].filter((i) => i.type === "permission" && i.state === "pending"),
    },
    tasks: {
      get: (task: string) => ({
        org: orgOf(task),
        // A task named `CAP-...` is the captain's lane: its lead is the agent of the runs below.
        ...(task.startsWith("CAP")
          ? { kind: "chat", brief: CAPTAIN_LANE_BRIEF, team: ["acme-claude"] }
          : { kind: "task", brief: "", team: ["acme-claude"] }),
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
  const deferred = new DeferredResults();
  const woken: string[] = [];
  const permissions = new PermissionFlow(
    {
      store,
      room,
      connections,
      config,
      deferred,
      notify: (_task, _agent, text, claim) => {
        if (claim?.() !== false) woken.push(text);
      },
    },
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
  return { permissions, runOf, ask, shell, items, held, added, rules, logged, deferred, woken };
}
