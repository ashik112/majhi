import { lifecycle, type PausedBy, type PausedReason, PausedReasonSchema } from "@majhi/shared";
import { and, desc, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../store/db.ts";
import { autonomyTasks, taskEvents, tasks } from "../../store/schema.ts";
import type { OutboxItem } from "./types.ts";

type StoredFields = lifecycle.StoredFields;
type Hold = lifecycle.Hold;

const StoredStatusSchema = z.enum(["inbox", "ready", "running", "paused", "review", "mr", "done"]);

/** A task as its row says, before the model reads it. */
export interface LoadedRow {
  stored: StoredFields;
  startWhenReady: boolean;
  /** The task's last update: the `at` of a hold the old fields cannot date. */
  at: string;
  /** What the run gate holds the task for, whatever its status says (the async window). */
  gate?: { held: "owner" | "limit"; scope?: string | undefined } | undefined;
}

export interface CommitInput {
  id: string;
  event: string;
  actor: string;
  at: string;
  before: { status: lifecycle.LifecycleStatus; hold: Hold | undefined };
  after: lifecycle.Lifecycle;
  startWhenReady: boolean;
  /** The row as it was loaded: `resumed_at` is kept, never rewritten. */
  loaded: LoadedRow;
  /** Effects to write into the outbox in this same transaction. */
  outbox: readonly OutboxItem[];
}

export interface RefusalInput {
  id: string;
  event: string;
  actor: string;
  at: string;
  status: lifecycle.LifecycleStatus;
  hold: Hold | undefined;
  code: string;
  text: string;
}

export interface PendingRow {
  id: number;
  task: string;
  items: OutboxItem[];
}

const OutboxSchema = z.array(
  z.object({
    effect: z.looseObject({ kind: z.string() }),
    ctx: z.looseObject({ by: z.string() }),
  }),
);

const reasonOf = (v: string | null): PausedReason | undefined => {
  const parsed = PausedReasonSchema.safeParse(v);
  return parsed.success ? parsed.data : undefined;
};

/**
 * The only module that writes a task's status, pause reason and pause owner, and the audit and
 * outbox rows that go with them. It dual-writes today's columns (`paused_reason`, `paused_by`,
 * `autonomy_tasks.held`, `held_scope`, `resumed_at`) from the model through `toStored`, until
 * step E moves them onto one `hold` column. Only `apply()` calls it: the census guard counts every
 * other caller.
 */
export class LifecycleRows {
  constructor(private readonly db: Db) {}

  /** The stored lifecycle fields of a task, or undefined when it does not exist. */
  load(id: string): LoadedRow | undefined {
    const row = this.db
      .select({
        status: tasks.status,
        pausedReason: tasks.pausedReason,
        pausedBy: tasks.pausedBy,
        startWhenReady: tasks.startWhenReady,
        updatedAt: tasks.updatedAt,
        held: autonomyTasks.held,
        heldScope: autonomyTasks.heldScope,
        resumedAt: autonomyTasks.resumedAt,
      })
      .from(tasks)
      .leftJoin(autonomyTasks, eq(autonomyTasks.task, tasks.id))
      .where(eq(tasks.id, id))
      .get();
    if (row === undefined) return undefined;
    const status = StoredStatusSchema.parse(row.status);
    const pausedBy: PausedBy | undefined =
      row.pausedBy === "captain" || row.pausedBy === "autonomy-off" ? row.pausedBy : undefined;
    return {
      stored: {
        status,
        pausedReason: reasonOf(row.pausedReason),
        pausedBy,
        // `held` on a row that is not paused is the run gate's async window, which the task does not
        // carry as a hold yet (the run reports it with `runPaused`). It is read for a paused row only.
        held: status === "paused" && (row.held === "owner" || row.held === "limit") ? row.held : undefined,
        heldScope: status === "paused" ? (row.heldScope ?? undefined) : undefined,
        resumedAt: row.resumedAt ?? undefined,
      },
      startWhenReady: row.startWhenReady,
      at: row.updatedAt,
      ...(row.held === "owner" || row.held === "limit"
        ? { gate: { held: row.held, scope: row.heldScope ?? undefined } }
        : {}),
    };
  }

  /**
   * Writes the new state, the audit row and the outbox in one transaction. Any failure rolls all of
   * it back: a task is never half moved. Returns the audit row's id.
   */
  commit(input: CommitInput): number {
    const f = lifecycle.toStored(input.after, {
      at: input.at,
      resumedAt: input.loaded.stored.resumedAt,
    }).fields;
    return this.db.transaction((tx) => {
      tx.update(tasks)
        .set({
          status: f.status,
          pausedReason: f.pausedReason ?? null,
          pausedBy: f.status === "paused" ? (f.pausedBy ?? null) : null,
          startWhenReady: input.startWhenReady,
          updatedAt: input.at,
        })
        .where(eq(tasks.id, input.id))
        .run();
      // What the run gate keeps for an autonomous task. A `limit` hold never replaces an `owner` one.
      if (f.held !== undefined) {
        tx.update(autonomyTasks)
          .set({ held: f.held, heldScope: f.heldScope ?? null })
          .where(
            f.held === "owner"
              ? eq(autonomyTasks.task, input.id)
              : and(
                  eq(autonomyTasks.task, input.id),
                  or(isNull(autonomyTasks.held), eq(autonomyTasks.held, "limit")),
                ),
          )
          .run();
      }
      if (f.resumedAt !== undefined && f.resumedAt !== input.loaded.stored.resumedAt) {
        tx.update(autonomyTasks)
          .set({ resumedAt: f.resumedAt })
          .where(eq(autonomyTasks.task, input.id))
          .run();
      }
      const row = tx
        .insert(taskEvents)
        .values({
          task: input.id,
          at: input.at,
          event: input.event,
          fromStatus: input.before.status,
          toStatus: input.after.status,
          fromHold: input.before.hold?.cause ?? null,
          hold: input.after.hold?.cause ?? null,
          actor: input.actor,
          refused: false,
          pendingEffects: input.outbox.length === 0 ? null : JSON.stringify(input.outbox),
        })
        .returning({ id: taskEvents.id })
        .get();
      return row.id;
    });
  }

  /** A refused event: one audit row, nothing else written. */
  refuse(input: RefusalInput): void {
    this.db
      .insert(taskEvents)
      .values({
        task: input.id,
        at: input.at,
        event: input.event,
        fromStatus: input.status,
        toStatus: input.status,
        fromHold: input.hold?.cause ?? null,
        hold: input.hold?.cause ?? null,
        actor: input.actor,
        refused: true,
        code: input.code,
        text: input.text.slice(0, 500),
      })
      .run();
  }

  /** What is still in the outbox of one event: the effects from the one that failed on, or nothing. */
  settle(eventId: number, remaining: readonly OutboxItem[]): void {
    this.db
      .update(taskEvents)
      .set({ pendingEffects: remaining.length === 0 ? null : JSON.stringify(remaining) })
      .where(eq(taskEvents.id, eventId))
      .run();
  }

  /** Events whose effects were not all run, oldest first. A row that does not parse is cleared. */
  pending(): PendingRow[] {
    const rows = this.db
      .select({ id: taskEvents.id, task: taskEvents.task, pending: taskEvents.pendingEffects })
      .from(taskEvents)
      .where(isNotNull(taskEvents.pendingEffects))
      .orderBy(taskEvents.id)
      .all();
    const out: PendingRow[] = [];
    for (const r of rows) {
      let items: unknown;
      try {
        items = JSON.parse(r.pending ?? "[]");
      } catch {
        items = undefined;
      }
      const parsed = OutboxSchema.safeParse(items);
      if (!parsed.success) {
        this.settle(r.id, []);
        continue;
      }
      // The outbox only ever holds what `commit` wrote from the model's own `Effect` type.
      out.push({ id: r.id, task: r.task, items: parsed.data as unknown as OutboxItem[] });
    }
    return out;
  }

  /** True when the task has an event after this one: what the row would do is out of date. */
  superseded(task: string, eventId: number): boolean {
    return (
      this.db
        .select({ id: taskEvents.id })
        .from(taskEvents)
        .where(and(eq(taskEvents.task, task), gt(taskEvents.id, eventId)))
        .limit(1)
        .get() !== undefined
    );
  }

  /** The audit trail of a task, newest first. */
  events(task: string, limit = 50): (typeof taskEvents.$inferSelect)[] {
    return this.db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.task, task))
      .orderBy(desc(taskEvents.id))
      .limit(limit)
      .all();
  }
}
