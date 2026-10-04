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
    expect(posted[0]).toContain("done");
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
    ).rejects.toThrow(/another workspace/);
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: def({
          kind: "command",
          task: "ACM-9",
          command: "curl -H 'x: sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'",
        }),
      }),
    ).rejects.toThrow(/secret/);
    await expect(
      w.ops.engine.save({ org: "acme", def: def({ kind: "process", task: "GLX-1", on: "any" }) }),
    ).rejects.toThrow(/another workspace/);
    expect(started).toEqual([]);
  });

  it("a merge request that is merged fires once", async () => {
    tasks.set("ACM-9", {
      org: "acme",
      status: "running",
      mr: { url: "u", number: 4, state: "open", ci: "passing" },
    });
    await w.ops.engine.save({ org: "acme", def: def({ kind: "mr", task: "ACM-9", on: "merged" }) });
    await look();
    expect(posted).toEqual([]);
    tasks.set("ACM-9", {
      org: "acme",
      status: "running",
      mr: { url: "u", number: 4, state: "merged", ci: "passing" },
    });
    await look();
    await look();
    expect(posted).toHaveLength(1);
  });

  it("a branch that gets new commits fires once per move", async () => {
    await w.ops.engine.save({
      org: "acme",
      def: def({ kind: "branch", project: "acme-api", branch: "main" }),
    });
    await look();
    tip = "ffffffff00";
    await look();
    await look();
    expect(posted).toHaveLength(1);
    tip = "1111111100";
    await look();
    expect(posted).toHaveLength(2);
  });

  it("a process that exits with an error fires once, a clean exit does not", async () => {
    procs.set("ACM-9/p1", {
      id: "p1",
      task: "ACM-9",
      name: "build",
      status: "running",
      tail: [],
    } as unknown as ProcessInfo);
    await w.ops.engine.save({
      org: "acme",
      def: def({ kind: "process", task: "ACM-9", on: "failure" }),
    });
    await look();
    procs.set("ACM-9/p1", {
      id: "p1",
      task: "ACM-9",
      name: "build",
      status: "exited",
      exitCode: 0,
      tail: [],
    } as unknown as ProcessInfo);
    await look();
    expect(posted).toEqual([]);
    procs.set("ACM-9/p2", {
      id: "p2",
      task: "ACM-9",
      name: "test",
      status: "exited",
      exitCode: 1,
      tail: [],
    } as unknown as ProcessInfo);
    await look();
    await look();
    expect(posted).toHaveLength(1);
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

  it("a command watch runs in the task, waits for it to end, and fires when its output changes", async () => {
    await w.ops.engine.save({
      org: "acme",
      def: def({ kind: "command", task: "ACM-9", command: "pnpm lint" }, { type: "changed" }, {}, 1),
    });
    // The first look started the command and has nothing to say yet.
    expect(started).toEqual(["pnpm lint"]);
    const end = (out: string[]) =>
      procs.set("ACM-9/p1", {
        id: "p1",
        task: "ACM-9",
        name: "w",
        status: "exited",
        exitCode: 0,
        tail: out,
      } as unknown as ProcessInfo);
    await look();
    expect(started).toHaveLength(1);
    end(["3 problems"]);
    await look();
    expect(posted).toEqual([]);
    // Next round: the command runs again, and its output differs.
    await look();
    expect(started).toHaveLength(2);
    procs.set("ACM-9/p2", {
      id: "p2",
      task: "ACM-9",
      name: "w",
      status: "exited",
      exitCode: 0,
      tail: ["0 problems"],
    } as unknown as ProcessInfo);
    await look();
    expect(posted).toHaveLength(1);
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

  it("the sentence planner reads task and merge request sentences, with an action", async () => {
    const done = await w.ops.engine.plan({ text: "tell me when ACM-9 is done" });
    expect(done.org).toBe("acme");
    expect(done.by).toBe("rules");
    expect(done.def.spec).toEqual({ kind: "task", task: "ACM-9", to: "done" });
    expect(done.def.fire.alert.on).toBe(true);
    expect(done.def.fire.run).toBeUndefined();

    const deploy = await w.ops.engine.plan({
      text: "when the MR for ACM-9 is merged, start a task to deploy to staging",
    });
    expect(deploy.def.spec).toEqual({ kind: "mr", task: "ACM-9", on: "merged" });
    expect(deploy.def.fire.alert.on).toBe(false);
    expect(deploy.def.fire.run).toMatchObject({ kind: "task.start", project: "acme-api" });
    expect(deploy.line).toContain("start a task");

    const spend = await w.ops.engine.plan({ text: "alert me when cost today goes over $25", org: "acme" });
    expect(spend.def.spec).toEqual({ kind: "usage", source: "spend", metric: "costUsd", period: "today" });
    expect(spend.def.condition).toEqual({ type: "above", value: 25, forMin: 0 });
  });
});

describe("merge request reviews", () => {
  const open = (review?: RepoMr["review"]): FakeTask => ({
    org: "acme",
    status: "running",
    mr: { url: "u", number: 4, state: "open", ci: "passing", ...(review === undefined ? {} : { review }) },
  });
  const pending = { approved: false, approvals: 0, changesRequested: false, pending: ["ana"] };

  it("an approval fires once, and again only after it was lost and given again", async () => {
    tasks.set("ACM-9", open(pending));
    await w.ops.engine.save({ org: "acme", def: def({ kind: "mr", task: "ACM-9", on: "approved" }) });
    await look();
    expect(posted).toEqual([]);
    tasks.set("ACM-9", open({ approved: true, approvals: 1, changesRequested: false, pending: [] }));
    await look();
    await look();
    expect(posted).toHaveLength(1);
    tasks.set("ACM-9", open({ approved: false, approvals: 0, changesRequested: true, pending: [] }));
    await look();
    expect(posted).toHaveLength(1);
    tasks.set("ACM-9", open({ approved: true, approvals: 1, changesRequested: false, pending: [] }));
    await look();
    expect(posted).toHaveLength(2);
  });

  it("changes requested and a new reviewer asked each fire once", async () => {
    tasks.set("ACM-9", open(pending));
    await w.ops.engine.save({
      org: "acme",
      def: def({ kind: "mr", task: "ACM-9", on: "changesRequested" }),
    });
    await w.ops.engine.save({
      org: "acme",
      def: def({ kind: "mr", task: "ACM-9", on: "reviewRequested" }),
    });
    await look();
    expect(posted).toEqual([]);
    tasks.set("ACM-9", open({ approved: false, approvals: 0, changesRequested: true, pending: ["ana"] }));
    await look();
    await look();
    expect(posted).toHaveLength(1);
    tasks.set(
      "ACM-9",
      open({ approved: false, approvals: 0, changesRequested: true, pending: ["ana", "bo"] }),
    );
    await look();
    await look();
    expect(posted).toHaveLength(2);
  });

  it("the planner reads 'tell me when the MR for ACM-9 is approved'", async () => {
    tasks.set("ACM-9", open(pending));
    const p = await w.ops.engine.plan({ text: "tell me when the MR for ACM-9 is approved" });
    expect(p.def.spec).toEqual({ kind: "mr", task: "ACM-9", on: "approved" });
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
    expect(posted[0]).toContain("92");
    limits.accounts.set("acme-claude", { org: "acme", weekly: window(40) });
    await look();
    limits.accounts.set("acme-claude", { org: "acme", weekly: window(95) });
    await look();
    expect(posted).toHaveLength(2);
  });

  it("resets fires once per reset, and not for a window that never hit its limit", async () => {
    await w.ops.engine.save({
      org: "acme",
      def: def({ kind: "usage", source: "account5h", account: "acme-claude" }, { type: "resets" }),
    });
    await look();
    limits.accounts.set("acme-claude", { org: "acme", window: window(60) });
    await look();
    expect(posted).toEqual([]);
    limits.accounts.set("acme-claude", { org: "acme", window: window(100) });
    await look();
    await look();
    expect(posted).toEqual([]);
    limits.accounts.set("acme-claude", { org: "acme", window: window(3) });
    await look();
    await look();
    expect(posted).toHaveLength(1);
    limits.accounts.set("acme-claude", { org: "acme", window: window(100) });
    await look();
    limits.accounts.set("acme-claude", { org: "acme", window: window(0) });
    await look();
    expect(posted).toHaveLength(2);
  });

  it("budgets, the Auto-pilot day and the monthly ceiling read as percents", async () => {
    limits.budgets.set("org:acme", window(85));
    limits.day = window(70);
    limits.month = window(100);
    for (const spec of [
      { kind: "usage", source: "budget" },
      { kind: "usage", source: "autopilotDay" },
      { kind: "usage", source: "monthlyCeiling" },
    ]) {
      await w.ops.engine.save({ org: "acme", def: def(spec, { type: "atLimit" }) });
    }
    await look();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("monthly ceiling");
  });

  it("refuses an account of another workspace, allows a private one, and limit conditions on spend", async () => {
    limits.accounts.set("globex-codex", { org: "globex", weekly: window(10) });
    limits.accounts.set("owner-claude", { org: "private", weekly: window(10) });
    const save = (account: string) =>
      w.ops.engine.save({
        org: "acme",
        def: def({ kind: "usage", source: "accountWeek", account }, { type: "above", value: 90, forMin: 0 }),
      });
    await expect(save("globex-codex")).rejects.toThrow(/another workspace/);
    await expect(save("nobody")).rejects.toThrow(/does not exist/);
    await expect(save("owner-claude")).resolves.toBeDefined();
    await expect(
      w.ops.engine.save({
        org: "acme",
        def: def({ kind: "usage", source: "spend" }, { type: "resets" }),
      }),
    ).rejects.toThrow(/limit/);
  });

  it("the planner reads the limit sentences, and 'resume my paused tasks' is an action", async () => {
    const week = await w.ops.engine.plan({
      text: "tell me when acme-claude is at 90% of its weekly limit",
      org: "acme",
    });
    expect(week.def.spec).toMatchObject({ kind: "usage", source: "accountWeek", account: "acme-claude" });
    expect(week.def.condition).toMatchObject({ type: "above" });
    const reset = await w.ops.engine.plan({
      text: "when the 5h window of acme-claude resets, resume my paused tasks",
      org: "acme",
    });
    expect(reset.def.spec).toMatchObject({ kind: "usage", source: "account5h", account: "acme-claude" });
    expect(reset.def.condition).toEqual({ type: "resets" });
    expect(reset.def.fire.run).toEqual({ kind: "tasks.resume" });
  });
});
