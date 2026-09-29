import { type RoomItem, RoomItemSchema, type TaskId } from "@majhi/shared";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { roomItems } from "./schema.ts";

/** An item's own fields: everything but the ones the store assigns. */
export type RoomPayload = RoomItem extends infer T
  ? T extends RoomItem
    ? Omit<T, "id" | "task" | "seq" | "at">
    : never
  : never;

const PayloadSchema = z.record(z.string(), z.unknown());

/** Room items: one row per (task, id), replaced in place, with a per-task `seq` that grows on every write. */
export class RoomRepo {
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly db: Db) {}

  /**
   * Inserts or replaces an item and gives it the next `seq`. `at` is set once, on insert,
   * and strictly increases within a task, so sorting by `at` gives the order items appeared in.
   */
  upsert(task: TaskId, id: string, payload: RoomPayload): RoomItem {
    return this.db.transaction((tx) => {
      const existing = tx
        .select({ at: roomItems.at })
        .from(roomItems)
        .where(and(eq(roomItems.task, task), eq(roomItems.id, id)))
        .get();
      const top = tx
        .select({ seq: sql<number>`coalesce(max(${roomItems.seq}), 0)` })
        .from(roomItems)
        .where(eq(roomItems.task, task))
        .get();
      const seq = (top?.seq ?? 0) + 1;
      const at = existing?.at ?? this.nextAt(task);
      const item = RoomItemSchema.parse({ ...payload, id, task, seq, at });
      tx.insert(roomItems)
        .values({ task, id, seq, type: item.type, payload: JSON.stringify(payload), at })
        .onConflictDoUpdate({
          target: [roomItems.task, roomItems.id],
          set: { seq, type: item.type, payload: JSON.stringify(payload) },
        })
        .run();
      return item;
    });
  }

  get(task: string, id: string): RoomItem | undefined {
    const row = this.db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, task), eq(roomItems.id, id)))
      .get();
    return row === undefined ? undefined : toItem(row);
  }

  /** Newest first by `seq`, at most `limit`, and whether older ones exist. */
  page(task: string, limit: number, beforeSeq?: number): { items: RoomItem[]; more: boolean } {
    const rows = this.db
      .select()
      .from(roomItems)
      .where(
        beforeSeq === undefined
          ? eq(roomItems.task, task)
          : and(eq(roomItems.task, task), lt(roomItems.seq, beforeSeq)),
      )
      .orderBy(desc(roomItems.seq))
      .limit(limit + 1)
      .all();
    return { items: rows.slice(0, limit).map(toItem), more: rows.length > limit };
  }

  /** Owner items waiting for the agent's next turn, in the order they were sent. */
  queuedFor(task: string, agent: string): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(
        and(
          eq(roomItems.task, task),
          eq(roomItems.type, "owner"),
          sql`json_extract(${roomItems.payload}, '$.queued') = 1`,
          sql`coalesce(json_extract(${roomItems.payload}, '$.to'), '') = ${agent}`,
        ),
      )
      .orderBy(asc(roomItems.at))
      .all()
      .map(toItem);
  }

  /** Permission prompts still marked pending, in any task. */
  pendingPermissions(): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(
        and(eq(roomItems.type, "permission"), sql`json_extract(${roomItems.payload}, '$.state') = 'pending'`),
      )
      .all()
      .map(toItem);
  }

  /** Approval cards that ran a config change and can be undone through this commit. */
  approvalsByCommit(commit: string): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(
        and(eq(roomItems.type, "approval"), sql`json_extract(${roomItems.payload}, '$.commit') = ${commit}`),
      )
      .all()
      .map(toItem);
  }

  private nextAt(task: string): string {
    let last = this.lastAt.get(task);
    if (last === undefined) {
      const row = this.db
        .select({ at: sql<string | null>`max(${roomItems.at})` })
        .from(roomItems)
        .where(eq(roomItems.task, task))
        .get();
      last = row?.at ? Date.parse(row.at) : 0;
    }
    const next = Math.max(Date.now(), last + 1);
    this.lastAt.set(task, next);
    return new Date(next).toISOString();
  }
}

function toItem(row: typeof roomItems.$inferSelect): RoomItem {
  const payload = PayloadSchema.parse(JSON.parse(row.payload));
  return RoomItemSchema.parse({ ...payload, id: row.id, task: row.task, seq: row.seq, at: row.at });
}
