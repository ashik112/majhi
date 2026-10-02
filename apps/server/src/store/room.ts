import { type RoomItem, RoomItemSchema, type RoomSearchHit, type TaskId } from "@majhi/shared";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
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

/** Item types that wait for the owner while their `state` is pending. */
const OWNER_WAIT_TYPES: RoomItem["type"][] = [
  "approval",
  "permission",
  "secret-request",
  "ask",
  "choice",
  "owner-question",
];
const PENDING = sql`json_extract(${roomItems.payload}, '$.state') = 'pending'`;

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
    return { items: rows.slice(0, limit).flatMap(readable), more: rows.length > limit };
  }

  /** The next `limit` items after `afterSeq`, newest first, and whether newer ones exist beyond them. */
  pageAfter(task: string, limit: number, afterSeq: number): { items: RoomItem[]; more: boolean } {
    const rows = this.db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, task), gt(roomItems.seq, afterSeq)))
      .orderBy(asc(roomItems.seq))
      .limit(limit + 1)
      .all();
    return { items: rows.slice(0, limit).flatMap(readable).reverse(), more: rows.length > limit };
  }

  /**
   * The page around one item: up to `half` items before it, the item, and up to `half` after, newest
   * first. `older` and `newer` say whether the room holds more on either side. Undefined when there
   * is no such item (or it cannot be read).
   */
  around(
    task: string,
    id: string,
    half: number,
  ): { items: RoomItem[]; older: boolean; newer: boolean } | undefined {
    const row = this.db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, task), eq(roomItems.id, id)))
      .get();
    const target = row === undefined ? undefined : toItem(row);
    if (target === undefined) return undefined;
    const before = this.page(task, half, target.seq);
    const after = this.pageAfter(task, half, target.seq);
    return { items: [...after.items, target, ...before.items], older: before.more, newer: after.more };
  }

  /** Owner messages and handoffs waiting for the agent's next turn, in the order they were sent. */
  queuedFor(task: string, agent: string): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(
        and(
          eq(roomItems.task, task),
          inArray(roomItems.type, ["owner", "handoff"]),
          sql`json_extract(${roomItems.payload}, '$.queued') = 1`,
          sql`coalesce(json_extract(${roomItems.payload}, '$.to'), '') = ${agent}`,
        ),
      )
      .orderBy(asc(roomItems.at))
      .all()
      .flatMap(readable);
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
      .flatMap(readable);
  }

  /** Items of one type in a task whose `state` is pending, oldest first. */
  pendingOfType(task: string, type: RoomItem["type"]): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(
        and(
          eq(roomItems.task, task),
          eq(roomItems.type, type),
          sql`json_extract(${roomItems.payload}, '$.state') = 'pending'`,
        ),
      )
      .orderBy(asc(roomItems.at))
      .all()
      .flatMap(readable);
  }

  /** Tasks with something pending for the owner: an approval, a permission, a secret, a question. One query. */
  tasksWaitingOnOwner(): Set<string> {
    const rows = this.db
      .selectDistinct({ task: roomItems.task })
      .from(roomItems)
      .where(and(inArray(roomItems.type, OWNER_WAIT_TYPES), PENDING))
      .all();
    return new Set(rows.map((r) => r.task));
  }

  /** The items behind `tasksWaitingOnOwner`, in every task, oldest first. One query. */
  waitingOnOwner(): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(and(inArray(roomItems.type, OWNER_WAIT_TYPES), PENDING))
      .orderBy(asc(roomItems.at))
      .all()
      .flatMap(readable);
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
      .flatMap(readable);
  }

  /**
   * Approval cards that appeared at or after `since` (ISO), counted per command, state and whether
   * they ran with no owner click (`alone`, or a saved `rule`). One query.
   */
  approvalCounts(since: string): { command: string; state: string; alone: boolean; n: number }[] {
    const rows = this.db.all<{ command: string | null; state: string | null; alone: number; n: number }>(sql`
      SELECT json_extract(payload, '$.command') AS command, json_extract(payload, '$.state') AS state,
        (json_extract(payload, '$.alone') IS NOT NULL OR json_extract(payload, '$.rule') IS NOT NULL) AS alone,
        count(*) AS n
      FROM room_items
      WHERE type = 'approval' AND at >= ${since}
      GROUP BY 1, 2, 3`);
    return rows.flatMap((r) =>
      r.command === null || r.state === null
        ? []
        : [{ command: r.command, state: r.state, alone: r.alone === 1, n: r.n }],
    );
  }

  /** How many items the task's room holds, not counting the ones whose id starts with `except`. */
  count(task: string, except?: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(roomItems)
      .where(
        except === undefined
          ? eq(roomItems.task, task)
          : and(eq(roomItems.task, task), sql`substr(${roomItems.id}, 1, ${except.length}) != ${except}`),
      )
      .get();
    return row?.n ?? 0;
  }

  /** Deletes every item of the task's room, and returns how many went. */
  deleteAll(task: string): number {
    const before = this.count(task);
    this.db.delete(roomItems).where(eq(roomItems.task, task)).run();
    this.lastAt.delete(task);
    return before;
  }

  /**
   * Room items whose text has every word of `query` (the last one as a prefix, so a search works
   * while it is typed), best match first. `org` limits it to that org's tasks.
   */
  search(query: string, limit: number, org?: string): RoomSearchHit[] {
    const match = matchQuery(query);
    if (match === undefined) return [];
    const rows = this.db.all<SearchRow>(sql`
      SELECT r.task AS task, t.title AS title, t.org AS org, r.id AS item, r.type AS type, r.at AS at,
        coalesce(json_extract(r.payload, '$.agent'), json_extract(r.payload, '$.from')) AS agent,
        snippet(room_search, 0, ${MARK_START}, ${MARK_END}, '…', 14) AS snippet
      FROM room_search
      JOIN room_items r ON r.rowid = room_search.rowid
      JOIN tasks t ON t.id = r.task
      WHERE room_search MATCH ${match} ${org === undefined ? sql`` : sql`AND t.org = ${org}`}
      ORDER BY room_search.rank, r.at DESC
      LIMIT ${limit}`);
    return rows.map((row) => ({
      task: row.task,
      taskTitle: row.title,
      org: row.org,
      item: row.item,
      type: row.type,
      ...(row.agent === null ? {} : { agent: row.agent }),
      at: row.at,
      snippet: snippetParts(row.snippet),
    }));
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

/**
 * A stored row as a room item, or undefined when the row cannot be read (a damaged payload after
 * a database recovery, say). One bad row must never take the room, or the server, down.
 */
function toItem(row: typeof roomItems.$inferSelect): RoomItem | undefined {
  try {
    const payload = PayloadSchema.safeParse(JSON.parse(row.payload));
    if (!payload.success) return undefined;
    const item = RoomItemSchema.safeParse({
      ...payload.data,
      id: row.id,
      task: row.task,
      seq: row.seq,
      at: row.at,
    });
    return item.success ? item.data : undefined;
  } catch {
    return undefined;
  }
}

/** Readable rows only: unreadable ones are skipped. */
const readable = (row: typeof roomItems.$inferSelect): RoomItem[] => {
  const item = toItem(row);
  return item === undefined ? [] : [item];
};

interface SearchRow {
  task: string;
  title: string;
  org: string | null;
  item: string;
  type: RoomSearchHit["type"];
  at: string;
  agent: string | null;
  snippet: string;
}

/** Bracket the matched words in a snippet. They are control characters, which no message holds. */
const MARK_START = "\u0002";
const MARK_END = "\u0003";

/** An FTS5 query from typed words: each word quoted, all required, the last one a prefix. Undefined when there are none. */
export function matchQuery(text: string): string | undefined {
  const words =
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 12) ?? [];
  if (words.length === 0) return undefined;
  return words.map((w, i) => (i === words.length - 1 ? `"${w}"*` : `"${w}"`)).join(" ");
}

/** A snippet with marked words as parts, matched words flagged. */
export function snippetParts(snippet: string): RoomSearchHit["snippet"] {
  const parts: RoomSearchHit["snippet"] = [];
  snippet.split(MARK_START).forEach((chunk, i) => {
    const [hit, rest] = i === 0 ? [undefined, chunk] : chunk.split(MARK_END);
    if (hit !== undefined && hit !== "") parts.push({ text: hit, hit: true });
    if (rest !== undefined && rest !== "") parts.push({ text: rest, hit: false });
  });
  return parts;
}
