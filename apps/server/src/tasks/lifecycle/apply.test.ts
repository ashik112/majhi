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
});
