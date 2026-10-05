import type { lifecycle, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../../store/index.ts";
import { seedStatus } from "../../testing/status.ts";
import { holdFromRunReason, TaskLifecycle, wasRefused } from "./apply.ts";
import type { EffectContext } from "./types.ts";

type Effect = lifecycle.Effect;

const AT = "2026-10-05T10:00:00.000Z";

function task(id: string): Task {
  return {
    id,
    title: id,
    brief: "brief",
    kind: "code",
    org: "acme",
    status: "inbox",
    folder: `/tasks/${id}`,
    repos: [],
    team: ["builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: AT,
    updatedAt: AT,
  } as Task;
}

interface Rig {
  store: Store;
  life: TaskLifecycle;
  ran: { id: string; effect: Effect; ctx: EffectContext }[];
  failOn: { kind?: string | undefined };
}

function rig(): Rig {
  const store = new Store(":memory:");
  store.tasks.insert(task("ACM-1"));
  const ran: Rig["ran"] = [];
  const failOn: Rig["failOn"] = {};
  const life = new TaskLifecycle({
    rows: store.lifecycle,
    now: () => new Date("2026-10-05T11:00:00.000Z"),
    unmetDeps: () => [],
    hasLiveRun: () => false,
    runner: {
      async run(id, effect, ctx) {
        if (failOn.kind === effect.kind) throw new Error("crash");
        ran.push({ id, effect, ctx });
      },
    },
  });
  return { store, life, ran, failOn };
}

const row = (store: Store, id = "ACM-1") =>
  store.raw
    .prepare("SELECT status, paused_reason, paused_by, start_when_ready, updated_at FROM tasks WHERE id = ?")
    .get(id) as {
    status: string;
    paused_reason: string | null;
    paused_by: string | null;
    start_when_ready: number;
    updated_at: string;
  };

const events = (store: Store) =>
  store.raw
    .prepare("SELECT event, refused, code, hold, pending_effects FROM task_events ORDER BY id")
    .all() as {
    event: string;
    refused: number;
    code: string | null;
    hold: string | null;
    pending_effects: string | null;
  }[];

describe("apply refuses without writing", () => {
  it("a refusal writes its event row and nothing else", () => {
    const { store, life } = rig();
    seedStatus(store, "ACM-1", "mr", undefined, AT);
    const before = row(store);
    return life.apply("ACM-1", { type: "start", by: "captain" }).then((out) => {
      expect(wasRefused(out) && out.code).toBe("wrong-status");
      expect(row(store)).toEqual(before);
      expect(events(store)).toEqual([
        { event: "start", refused: 1, code: "wrong-status", hold: null, pending_effects: null },
      ]);
    });
  });

  it("a held task refuses a start with the hold's sentence and stays paused", async () => {
    const { store, life } = rig();
    seedStatus(store, "ACM-1", "paused", "owner", AT);
    const out = await life.apply("ACM-1", { type: "start", by: "owner" });
    expect(wasRefused(out) && out.code).toBe("held");
    expect(row(store)).toMatchObject({ status: "paused", paused_reason: "owner" });
  });
});

describe("apply is atomic", () => {
  it("a failure while the event row is written rolls the state back", async () => {
    const { store, life } = rig();
    seedStatus(store, "ACM-1", "running", undefined, AT);
    store.raw.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT, 'disk full'); END;",
    );
    const before = row(store);
    await expect(life.apply("ACM-1", { type: "ownerStop", at: AT })).rejects.toThrow(/disk full/);
    expect(row(store)).toEqual(before);
    expect(store.raw.prepare("SELECT count(*) AS n FROM task_events").get()).toEqual({ n: 0 });
  });

  it("the state, the event row and the outbox row are written together", async () => {
    const { store, life, failOn } = rig();
    seedStatus(store, "ACM-1", "running", undefined, AT);
    failOn.kind = "card";
    await expect(life.apply("ACM-1", { type: "ownerStop", at: AT })).rejects.toThrow("crash");
    expect(row(store)).toMatchObject({ status: "paused", paused_reason: "owner" });
    const [e] = events(store);
    expect(e?.event).toBe("ownerStop");
    expect(e?.hold).toBe("owner-stop");
    expect(e?.pending_effects).toContain('"kind":"card"');
  });
});

describe("the outbox", () => {
  it("drains after a crash and a restart, and only once", async () => {
    const first = rig();
    seedStatus(first.store, "ACM-1", "running", undefined, AT);
    // The process dies on the first durable effect: the state and the outbox row are on disk.
    first.failOn.kind = "containers";
    await expect(first.life.apply("ACM-1", { type: "ownerStop", at: AT })).rejects.toThrow("crash");
    const pending = first.store.lifecycle.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.items.map((i) => i.effect.kind)).toEqual([
      "containers",
      "processes.stop",
      "terminals.stop",
      "dropPendingShip",
      "card",
    ]);

    // A new process on the same database, with a runner that works.
    const ran: string[] = [];
    const restarted = new TaskLifecycle({
      rows: first.store.lifecycle,
      now: () => new Date(AT),
      unmetDeps: () => [],
      hasLiveRun: () => false,
      runner: {
        async run(_id, effect) {
          ran.push(effect.kind);
        },
      },
    });
    expect(await restarted.drain()).toBe(1);
    expect(ran).toEqual(["containers", "processes.stop", "terminals.stop", "dropPendingShip", "card"]);
    expect(first.store.lifecycle.pending()).toEqual([]);
    expect(await restarted.drain()).toBe(0);
  });

  it("drops what a newer event made out of date", async () => {
    const { store, life, failOn } = rig();
    seedStatus(store, "ACM-1", "running", undefined, AT);
    failOn.kind = "card";
    await expect(life.apply("ACM-1", { type: "ownerStop", at: AT })).rejects.toThrow("crash");
    failOn.kind = undefined;
    await life.apply("ACM-1", { type: "holdCleared", by: "owner" });
    // The pause card of the first event must not come back for a task that runs again.
    const ran: string[] = [];
    const restarted = new TaskLifecycle({
      rows: store.lifecycle,
      now: () => new Date(AT),
      unmetDeps: () => [],
      hasLiveRun: () => false,
      runner: {
        async run(_id, effect) {
          ran.push(effect.kind);
        },
      },
    });
    await restarted.drain();
    expect(ran).toEqual([]);
    expect(store.lifecycle.pending()).toEqual([]);
  });
});

/**
 * What the old code wrote for each move, column by column (`tasks.status`, `paused_reason`,
 * `paused_by`; `autonomy_tasks.held`, `held_scope` where it set them). The dual write must match it.
 */
describe("the old columns round-trip with what the old code wrote", () => {
  interface Case {
    name: string;
    from: { status: string; reason?: string; by?: string };
    event: lifecycle.LifecycleEvent;
    want: { status: string; reason: string | null; by: string | null };
    held?: { held: string | null; scope: string | null };
  }
  const cases: Case[] = [
    {
      name: "owner stop",
      from: { status: "running" },
      event: { type: "ownerStop", at: AT },
      want: { status: "paused", reason: "owner", by: null },
    },
    {
      name: "owner stop from review",
      from: { status: "review" },
      event: { type: "ownerStop", at: AT },
      want: { status: "paused", reason: "owner", by: null },
    },
    {
      name: "captain stop",
      from: { status: "running" },
      event: { type: "captainStop", at: AT },
      want: { status: "paused", reason: "owner", by: "captain" },
    },
    {
      name: "Auto-pilot off, stop now",
      from: { status: "running" },
      event: { type: "autopilotOff", at: AT, mode: "now" },
      want: { status: "paused", reason: "owner", by: "autonomy-off" },
      held: { held: "owner", scope: "stop-now" },
    },
    {
      name: "loop guard",
      from: { status: "running" },
      event: { type: "holdPlaced", hold: { cause: "loop-guard", at: AT, why: "x" } },
      want: { status: "paused", reason: "loop", by: null },
    },
    {
      name: "idle watch",
      from: { status: "running" },
      event: { type: "holdPlaced", hold: { cause: "idle", at: AT, why: "x" } },
      want: { status: "paused", reason: "blocked", by: null },
    },
    {
      name: "run pauses offline",
      from: { status: "running" },
      event: { type: "runPaused", hold: { cause: "offline", at: AT } },
      want: { status: "paused", reason: "offline", by: null },
    },
    {
      name: "run pauses on an error, from review",
      from: { status: "review" },
      event: { type: "runPaused", hold: { cause: "error", at: AT, phase: "turn", error: "boom" } },
      want: { status: "paused", reason: "error", by: null },
    },
    {
      name: "run pauses signed out",
      from: { status: "running" },
      event: { type: "runPaused", hold: { cause: "signed-out", at: AT, account: "claude-acme" } },
      want: { status: "paused", reason: "signed-out", by: null },
    },
    {
      name: "run pauses at an account limit",
      from: { status: "running" },
      event: { type: "runPaused", hold: { cause: "account-limit", at: AT, account: "claude-acme" } },
      want: { status: "paused", reason: "limit", by: null },
    },
    {
      name: "run resumes by itself",
      from: { status: "paused", reason: "offline" },
      event: { type: "runResumed" },
      want: { status: "running", reason: null, by: null },
    },
    {
      name: "owner starts a paused task",
      from: { status: "paused", reason: "owner", by: "captain" },
      event: { type: "holdCleared", by: "owner" },
      want: { status: "running", reason: null, by: null },
    },
    {
      name: "start from ready",
      from: { status: "ready" },
      event: { type: "start", by: "owner" },
      want: { status: "running", reason: null, by: null },
    },
    {
      name: "send back from review",
      from: { status: "review" },
      event: { type: "sendBack", by: "owner" },
      want: { status: "running", reason: null, by: null },
    },
    {
      name: "the agents are idle",
      from: { status: "running" },
      event: { type: "agentsIdle" },
      want: { status: "review", reason: null, by: null },
    },
    {
      name: "a process ended",
      from: { status: "review" },
      event: { type: "processEnded" },
      want: { status: "running", reason: null, by: null },
    },
    {
      name: "a change made, in the inbox",
      from: { status: "inbox" },
      event: { type: "changeAndReview" },
      want: { status: "review", reason: null, by: null },
    },
    {
      name: "a merge request opens on a paused task",
      from: { status: "paused", reason: "owner" },
      event: { type: "mrOpened" },
      want: { status: "mr", reason: null, by: null },
    },
    {
      name: "close a paused task",
      from: { status: "paused", reason: "error" },
      event: { type: "close" },
      want: { status: "done", reason: null, by: null },
    },
    {
      name: "reopen to review",
      from: { status: "done" },
      event: { type: "reopen", to: "review" },
      want: { status: "review", reason: null, by: null },
    },
    {
      name: "reopen to the inbox",
      from: { status: "done" },
      event: { type: "reopen", to: "inbox" },
      want: { status: "inbox", reason: null, by: null },
    },
    {
      name: "a dependency closed unmerged",
      from: { status: "ready" },
      event: { type: "dependencyChanged", change: "closed-unmerged", on: ["ACM-2"], at: AT },
      want: { status: "paused", reason: "blocked", by: null },
    },
    {
      name: "a dependency removed",
      from: { status: "inbox" },
      event: { type: "dependencyChanged", change: "removed", on: ["ACM-2"], at: AT },
      want: { status: "paused", reason: "blocked", by: null },
    },
    {
      name: "a restart lost a running task",
      from: { status: "running" },
      event: { type: "runLost", at: AT, autoResume: false },
      want: { status: "paused", reason: "error", by: null },
    },
  ];

  it.each(cases)("$name", async ({ from, event, want, held }) => {
    const { store, life } = rig();
    seedStatus(store, "ACM-1", from.status, from.reason, AT, from.by);
    store.raw.prepare("INSERT INTO autonomy_tasks (task, since) VALUES ('ACM-1', ?)").run(AT);
    const out = await life.apply("ACM-1", event);
    expect(wasRefused(out)).toBe(false);
    const r = row(store);
    expect({ status: r.status, reason: r.paused_reason, by: r.paused_by }).toEqual(want);
    const a = store.raw.prepare("SELECT held, held_scope FROM autonomy_tasks WHERE task = 'ACM-1'").get() as {
      held: string | null;
      held_scope: string | null;
    };
    expect(a).toEqual({ held: held?.held ?? null, held_scope: held?.scope ?? null });
  });

  it("a run's pause reason in the old words builds the hold that writes the same reason", async () => {
    for (const reason of ["offline", "error", "limit", "owner", "signed-out"] as const) {
      const { store, life } = rig();
      seedStatus(store, "ACM-1", "running", undefined, AT);
      const loaded = life.load("ACM-1");
      if (loaded === undefined) throw new Error("no row");
      await life.apply("ACM-1", { type: "runPaused", hold: holdFromRunReason(reason, AT, loaded, "why") });
      expect(row(store)).toMatchObject({ status: "paused", paused_reason: reason, paused_by: null });
    }
  });

  it("the run gate's cap hold keeps the scope it held for", async () => {
    const { store, life } = rig();
    seedStatus(store, "ACM-1", "running", undefined, AT);
    store.raw
      .prepare(
        "INSERT INTO autonomy_tasks (task, since, held, held_scope) VALUES ('ACM-1', ?, 'limit', 'acme')",
      )
      .run(AT);
    const loaded = life.load("ACM-1");
    if (loaded === undefined) throw new Error("no row");
    await life.apply("ACM-1", { type: "runPaused", hold: holdFromRunReason("limit", AT, loaded) });
    expect(store.raw.prepare("SELECT held, held_scope FROM autonomy_tasks").get()).toEqual({
      held: "limit",
      held_scope: "acme",
    });
  });
});
