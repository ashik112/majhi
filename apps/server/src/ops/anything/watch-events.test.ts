import {
  type AutomationAction,
  type PausedReason,
  type ProcessInfo,
  type RepoMr,
  type TaskStatus,
  WatchDefSchema,
} from "@majhi/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { type ActionHost, ActionRunner } from "../../automation/actions.ts";
import { RunHistory } from "../../automation/history.ts";
import { MIN, type OpsWorld, opsWorld } from "../testing.ts";
import type { LimitUse, WatchHost, WatchTask } from "./host.ts";

/** The task, merge request, branch, process, usage and command watches fire once per change. */

interface FakeTask {
  org: string;
  status: TaskStatus;
  pausedReason?: PausedReason;
  mr?: RepoMr;
}

let tasks: Map<string, FakeTask>;
let procs: Map<string, ProcessInfo>;
let tip: string | undefined;
let cost: number;
const started: string[] = [];
const posted: string[] = [];

const actionHost: ActionHost = {
  resumeLimited: async () => ["ACM-9"],
  projects: async () => [{ id: "acme-api", org: "acme", aliases: [] }],
  agent: async () => undefined,
  task: (id) =>
    tasks.has(id)
      ? { id, org: tasks.get(id)?.org, status: "running", pausedReason: undefined, team: ["acme-dev"] }
      : undefined,
  startTask: async () => ({ id: "ACM-10" }),
  postToTask: async ({ text }) => {
    posted.push(text);
  },
  startProcess: async ({ task, command }) => {
    const id = `p${started.length + 1}`;
    started.push(command);
    procs.set(`${task}/${id}`, {
      id,
      task,
      name: command,
      status: "running",
      tail: [],
    } as unknown as ProcessInfo);
    return { id };
  },
  process: (task, id) => procs.get(`${task}/${id}`),
};

/** What the limit watches read. Tests set these. */
const limits = {
  accounts: new Map<string, { org: string; window?: LimitUse; weekly?: LimitUse }>(),
  budgets: new Map<string, LimitUse>(),
  day: undefined as LimitUse | undefined,
  month: undefined as LimitUse | undefined,
};

const watchHost: WatchHost = {
  limits: {
    accountList: async () => [...limits.accounts].map(([id, a]) => ({ id, org: a.org })),
    account: async (id) => limits.accounts.get(id),
    budget: async (scope, id) => limits.budgets.get(`${scope}:${id}`),
    autopilotDay: async () => limits.day,
    monthly: async () => limits.month,
  },
  tasks: () =>
    [...tasks].map(
      ([id, t]): WatchTask => ({
        id,
        org: t.org,
        status: t.status,
        pausedReason: t.pausedReason,
        project: "acme-api",
        mrs: () => (t.mr === undefined ? [] : [{ project: "acme-api", mr: t.mr }]),
      }),
    ),
  processes: (task) => [...procs].filter(([k]) => k.startsWith(`${task}/`)).map(([, p]) => p),
  process: (task, id) => procs.get(`${task}/${id}`),
  usage: () => ({ costUsd: cost, totalTokens: 0 }) as ReturnType<WatchHost["usage"]>,
  branchTip: async () => tip,
  startProcess: (input) => actionHost.startProcess(input),
};

const note: AutomationAction = { kind: "room.post", task: "ACM-9", text: "{{event}}" };
let w: OpsWorld;

beforeEach(() => {
  tasks = new Map([
    ["ACM-1", { org: "acme", status: "running" }],
    ["ACM-9", { org: "acme", status: "running" }],
    ["GLX-1", { org: "globex", status: "running" }],
  ]);
  procs = new Map();
  tip = "a1b2c3d4e5";
  cost = 1;
  started.length = 0;
  posted.length = 0;
  const first = opsWorld();
  w = opsWorld({
    db: first.db,
    wiring: {
      host: watchHost,
      projectCheckout: async (id) =>
        id === "acme-api" ? { org: "acme", path: "/Users/owner/acme-api" } : undefined,
      action: (() => {
        const history = new RunHistory(first.db);
        const runner = new ActionRunner(actionHost, history);
        return {
          validate: (org: string, action: AutomationAction) => runner.validate(org, action),
          run: (...args: Parameters<ActionRunner["run"]>) => runner.run(...args),
          runs: (id: string, limit: number) => history.list("watch", id, limit),
          forget: (id: string) => history.deleteFor("watch", id),
        };
      })(),
    },
  });
});

function def(
  spec: unknown,
  condition: unknown = { type: "changed" },
  fire: Record<string, unknown> = {},
  everyMin = 1,
) {
  return WatchDefSchema.parse({
    name: "Event",
    spec,
    condition,
    everyMin,
    fire: { alert: { on: false, phone: false }, run: note, ...fire },
  });
}

async function look(minutes = 1): Promise<void> {
  w.advance(minutes * MIN);
  await w.ops.engine.tick();
}

describe("event watches", () => {
  it("a task reaching done fires once, not on the first look and not when a task leaves", async () => {
    tasks.set("ACM-1", { org: "acme", status: "done" });
    await w.ops.engine.save({ org: "acme", def: def({ kind: "task", to: "done" }) });
    await look();
    expect(posted).toEqual([]);
    tasks.set("ACM-9", { org: "acme", status: "done" });
    await look();
    expect(posted).toHaveLength(1);
    await look();
    // One leaves the set (reopened): nothing fires. It comes back: that is a new event.
    tasks.set("ACM-9", { org: "acme", status: "running" });
    await look();
    expect(posted).toHaveLength(1);
    tasks.set("ACM-9", { org: "acme", status: "done" });
    await look();
    expect(posted).toHaveLength(2);
    expect(w.ops.watch.openIncidents()).toEqual([]);
  });

  it("refuses a task of another workspace and a command with a secret", async () => {
    await expect(
      w.ops.engine.save({ org: "acme", def: def({ kind: "task", task: "GLX-1", to: "done" }) }),
    ).rejects.toThrow(/./);
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: def({
          kind: "command",
          task: "ACM-9",
          command: "curl -H 'x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'",
        }),
      }),
    ).rejects.toThrow(/./);
    await expect(
      w.ops.engine.save({ org: "acme", def: def({ kind: "process", task: "GLX-1", on: "any" }) }),
    ).rejects.toThrow(/./);
    expect(started).toEqual([]);
  });

  it("usage over a limit fires when it crosses, and again only after it dropped and crossed again", async () => {
    await w.ops.engine.save({
      org: "acme",
      def: def(
        { kind: "usage", metric: "costUsd", period: "today" },
        { type: "above", value: 10, forMin: 0 },
      ),
    });
    await look();
    expect(posted).toEqual([]);
    cost = 11;
    await look();
    await look();
    expect(posted).toHaveLength(1);
    cost = 2;
    await look();
    cost = 12;
    await look();
    expect(posted).toHaveLength(2);
  });

  it("settle time and cooldown hold a firing back and keep the change for later", async () => {
    tip = "aaaaaaaa";
    await w.ops.engine.save({
      org: "acme",
      def: def(
        { kind: "branch", project: "acme-api", branch: "main" },
        { type: "changed" },
        { settleMin: 2, cooldownMin: 10 },
      ),
    });
    await look();
    tip = "bbbbbbbb";
    await look();
    // Settling: the change has not held for 2 minutes.
    expect(posted).toEqual([]);
    await look(2);
    expect(posted).toHaveLength(1);
    tip = "cccccccc";
    await look();
    await look(2);
    // Held long enough, but the cooldown after the last firing is not over.
    expect(posted).toHaveLength(1);
    await look(10);
    expect(posted).toHaveLength(2);
    await look(5);
    expect(posted).toHaveLength(2);
  });
});

describe("limit watches", () => {
  const window = (percent: number, resetsAt = "2026-10-05T00:00:00Z"): LimitUse => ({ percent, resetsAt });

  beforeEach(() => {
    limits.accounts.clear();
    limits.budgets.clear();
    limits.day = undefined;
    limits.month = undefined;
    limits.accounts.set("acme-claude", { org: "acme", window: window(10), weekly: window(50) });
  });

  it("an account's weekly window over N percent fires once per crossing", async () => {
    await w.ops.engine.save({
      org: "acme",
      def: def(
        { kind: "usage", source: "accountWeek", account: "acme-claude" },
        { type: "above", value: 90, forMin: 0 },
      ),
    });
    await look();
    expect(posted).toEqual([]);
    limits.accounts.set("acme-claude", { org: "acme", weekly: window(92) });
    await look();
    await look();
    expect(posted).toHaveLength(1);
    limits.accounts.set("acme-claude", { org: "acme", weekly: window(40) });
    await look();
    limits.accounts.set("acme-claude", { org: "acme", weekly: window(95) });
    await look();
    expect(posted).toHaveLength(2);
  });

  it("refuses an account of another workspace, allows a private one, and limit conditions on spend", async () => {
    limits.accounts.set("globex-codex", { org: "globex", weekly: window(10) });
    limits.accounts.set("owner-claude", { org: "private", weekly: window(10) });
    const save = (account: string) =>
      w.ops.engine.save({
        org: "acme",
        def: def({ kind: "usage", source: "accountWeek", account }, { type: "above", value: 90, forMin: 0 }),
      });
    await expect(save("globex-codex")).rejects.toThrow(/./);
    await expect(save("nobody")).rejects.toThrow(/./);
    await expect(save("owner-claude")).resolves.toBeDefined();
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: def({ kind: "usage", source: "spend" }, { type: "resets" }),
      }),
    ).rejects.toThrow(/./);
  });
});
