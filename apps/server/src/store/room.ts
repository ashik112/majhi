import {
  mentionedContacts,
  mentionNames,
  type RoomItem,
  RoomItemSchema,
  type RoomSearchHit,
  type TaskId,
} from "@majhi/shared";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { storedMentions } from "./mentions.ts";
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
/**
 * What of the captain's lane shows in the task it is about: its words, its cards and its notes. Its tool calls and
 * thoughts stay in the lane (one line with the result is what the task needs).
 */
const CAPTAIN_LINES_IN_TASK: RoomItem["type"][] = [
  "agent",
  "system",
  "approval",
  "permission",
  "secret-request",
  "ask",
  "choice",
  "owner-question",
];
/** An item whose `state` is pending: an indexed virtual column (migration 153), not a JSON parse per row. */
const PENDING = sql`${roomItems.pending} = 1`;

const TASK = sql.placeholder("task");
const ITEM = sql.placeholder("id");
const LIMIT = sql.placeholder("limit");
const SEQ = sql.placeholder("seq");

/** The hot queries, built and prepared once (Drizzle builds and prepares a plain query on every call). */
function roomStatements(db: Db) {
  return {
    at: db
      .select({ at: roomItems.at })
      .from(roomItems)
      .where(and(eq(roomItems.task, TASK), eq(roomItems.id, ITEM)))
      .prepare(),
    topSeq: db
      .select({ seq: sql<number>`coalesce(max(${roomItems.seq}), 0)` })
      .from(roomItems)
      .where(eq(roomItems.task, TASK))
      .prepare(),
    put: db
      .insert(roomItems)
      .values({
        task: TASK,
        id: ITEM,
        seq: SEQ,
        type: sql.placeholder("type"),
        payload: sql.placeholder("payload"),
        at: sql.placeholder("at"),
      })
      .onConflictDoUpdate({
        target: [roomItems.task, roomItems.id],
        set: { seq: sql`excluded.seq`, type: sql`excluded.type`, payload: sql`excluded.payload` },
      })
      .prepare(),
    get: db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, TASK), eq(roomItems.id, ITEM)))
      .prepare(),
    latest: db
      .select()
      .from(roomItems)
      .where(eq(roomItems.task, TASK))
      .orderBy(desc(roomItems.seq))
      .limit(LIMIT)
      .prepare(),
    before: db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, TASK), lt(roomItems.seq, SEQ)))
      .orderBy(desc(roomItems.seq))
      .limit(LIMIT)
      .prepare(),
    after: db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, TASK), gt(roomItems.seq, SEQ)))
      .orderBy(asc(roomItems.seq))
      .limit(LIMIT)
      .prepare(),
  };
}

/** Room items: one row per (task, id), replaced in place, with a per-task `seq` that grows on every write. */
export class RoomRepo {
  private readonly lastAt = new Map<string, number>();
  private prepared: ReturnType<typeof roomStatements> | undefined;

  constructor(private readonly db: Db) {}

  /** A contact's stored name, for a mention a message carries no name for. */
  private readonly contactName = (id: string): string | undefined =>
    this.db.get<{ name: string }>(sql`SELECT name FROM contacts WHERE id = ${id}`)?.name;

  private get q(): ReturnType<typeof roomStatements> {
    this.prepared ??= roomStatements(this.db);
    return this.prepared;
  }

  /**
   * Inserts or replaces an item and gives it the next `seq`. `at` is set once, on insert,
   * and strictly increases within a task, so sorting by `at` gives the order items appeared in.
   */
  upsert(task: TaskId, id: string, payload: RoomPayload): RoomItem {
    // Prepared statements run on the same connection, so they sit inside this transaction.
    return this.db.transaction(() => {
      const existing = this.q.at.get({ task, id });
      const top = this.q.topSeq.get({ task });
      const seq = (top?.seq ?? 0) + 1;
      const at = existing?.at ?? this.nextAt(task);
      const item = RoomItemSchema.parse({ ...payload, id, task, seq, at });
      this.q.put.run({ task, id, seq, type: item.type, payload: JSON.stringify(payload), at });
      return item;
    });
  }

  get(task: string, id: string): RoomItem | undefined {
    const row = this.q.get.get({ task, id });
    return row === undefined ? undefined : toItem(row);
  }

  /** The item a chat app's message was stored as, found by its external key (`externalKeyText`). */
  byExternal(external: string): RoomItem | undefined {
    const row = this.db.select().from(roomItems).where(sql`${roomItems.external} = ${external}`).get();
    return row === undefined ? undefined : toItem(row);
  }

  /**
   * Stores a message of a chat app under its external key, once. `make` gets the item already stored for the key
   * (undefined for a first delivery) and returns what to store, or undefined to leave it as it is: a repeat delivery
   * stores nothing. The key is unique, so two deliveries at once cannot both insert.
   */
  putExternal(
    task: TaskId,
    external: string,
    id: string,
    make: (existing: RoomItem | undefined) => RoomPayload | undefined,
  ): { item: RoomItem; created: boolean } | undefined {
    return this.db.transaction(() => {
      const existing = this.byExternal(external);
      const payload = make(existing);
      if (payload === undefined) return undefined;
      const item = this.upsert(existing?.task ?? task, existing?.id ?? id, payload);
      this.db.run(
        sql`UPDATE room_items SET external = ${external} WHERE task = ${item.task} AND id = ${item.id}`,
      );
      return { item, created: existing === undefined };
    });
  }

  /** Newest first by `seq`, at most `limit`, and whether older ones exist. */
  page(task: string, limit: number, beforeSeq?: number): { items: RoomItem[]; more: boolean } {
    const rows =
      beforeSeq === undefined
        ? this.q.latest.all({ task, limit: limit + 1 })
        : this.q.before.all({ task, seq: beforeSeq, limit: limit + 1 });
    return { items: rows.slice(0, limit).flatMap(readable), more: rows.length > limit };
  }

  /** A room's items newest first by `at`, older than `olderThan` when given. */
  pageAt(task: string, limit: number, olderThan?: string): { items: RoomItem[]; more: boolean } {
    return this.mergedPageAny([task], limit, olderThan);
  }

  private mergedPageAny(rooms: readonly string[], limit: number, olderThan?: string) {
    const rows = this.db
      .select()
      .from(roomItems)
      .where(
        and(
          inArray(roomItems.task, [...rooms]),
          olderThan === undefined ? undefined : lt(roomItems.at, olderThan),
        ),
      )
      .orderBy(desc(roomItems.at))
      .limit(limit + 1)
      .all();
    return { items: rows.slice(0, limit).flatMap(readable), more: rows.length > limit };
  }

  /**
   * Items of several rooms read as one, newest first by `at`, at most `limit`, and whether older ones exist.
   * `about`: only the lines tagged with that task. `untagged`: only the lines about no task. `olderThan` and `newerThan`
   * are `at` bounds, exclusive. The captain's thread and a task's timeline are reads of this kind (`roomWithCaptain`).
   */
  mergedPage(
    rooms: readonly string[],
    which: { about: string } | { untagged: true },
    limit: number,
    bounds: { olderThan?: string; newerThan?: string } = {},
  ): { items: RoomItem[]; more: boolean } {
    if (rooms.length === 0) return { items: [], more: false };
    const tag =
      "about" in which
        ? and(eq(roomItems.about, which.about), inArray(roomItems.type, CAPTAIN_LINES_IN_TASK))
        : sql`${roomItems.about} IS NULL`;
    const rows = this.db
      .select()
      .from(roomItems)
      .where(
        and(
          inArray(roomItems.task, [...rooms]),
          tag,
          bounds.olderThan === undefined ? undefined : lt(roomItems.at, bounds.olderThan),
          bounds.newerThan === undefined ? undefined : gt(roomItems.at, bounds.newerThan),
        ),
      )
      .orderBy(desc(roomItems.at))
      .limit(limit + 1)
      .all();
    return { items: rows.slice(0, limit).flatMap(readable), more: rows.length > limit };
  }

  /** The client messages, in any client room, that became or joined the task. */
  clientLinesOf(task: string, limit: number, olderThan?: string): { items: RoomItem[]; more: boolean } {
    const rows = this.db
      .select()
      .from(roomItems)
      .where(
        and(
          eq(roomItems.outcomeTask, task),
          eq(roomItems.type, "client"),
          olderThan === undefined ? undefined : lt(roomItems.at, olderThan),
        ),
      )
      .orderBy(desc(roomItems.at))
      .limit(limit + 1)
      .all();
    return { items: rows.slice(0, limit).flatMap(readable), more: rows.length > limit };
  }

  /** The next `limit` items after `afterSeq`, newest first, and whether newer ones exist beyond them. */
  pageAfter(task: string, limit: number, afterSeq: number): { items: RoomItem[]; more: boolean } {
    const rows = this.q.after.all({ task, seq: afterSeq, limit: limit + 1 });
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
    const row = this.q.get.get({ task, id });
    const target = row === undefined ? undefined : toItem(row);
    if (target === undefined) {
      // A captain line tagged to this task lives in its workspace thread's room: show it alone.
      const tagged = this.db
        .select()
        .from(roomItems)
        .where(and(eq(roomItems.id, id), eq(roomItems.about, task)))
        .get();
      const found = tagged === undefined ? undefined : toItem(tagged);
      return found === undefined ? undefined : { items: [found], older: false, newer: false };
    }
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
      .where(and(eq(roomItems.type, "permission"), PENDING))
      .all()
      .flatMap(readable);
  }

  /** Every item of one type in a task, oldest first. */
  ofType(task: string, type: RoomItem["type"]): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, task), eq(roomItems.type, type)))
      .orderBy(asc(roomItems.at))
      .all()
      .flatMap(readable);
  }

  /** Items of one type in a task whose `state` is pending, oldest first. */
  pendingOfType(task: string, type: RoomItem["type"]): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(and(eq(roomItems.task, task), eq(roomItems.type, type), PENDING))
      .orderBy(asc(roomItems.at))
      .all()
      .flatMap(readable);
  }

  /**
   * Pending items of the given types in the given tasks, oldest first, in one query (`pendingOfType` runs
   * one per task and type). Tasks with none are not in the map.
   */
  pendingOfTypes(tasks: readonly string[], types: readonly RoomItem["type"][]): Map<string, RoomItem[]> {
    const out = new Map<string, RoomItem[]>();
    // Pending cards are few, so read them all through the pending index and keep the asked tasks:
    // cheaper than one query per chunk of ids, and the same however many tasks are asked.
    const wanted = new Set(tasks);
    const rows = this.db
      .select()
      .from(roomItems)
      .where(and(inArray(roomItems.type, [...types]), PENDING))
      .orderBy(asc(roomItems.at))
      .all();
    for (const item of rows.flatMap(readable)) {
      if (!wanted.has(item.task)) continue;
      const own = out.get(item.task);
      if (own === undefined) out.set(item.task, [item]);
      else own.push(item);
    }
    return out;
  }

  /** Tasks with something pending for the owner: an approval, a permission, a secret, a question. One query. */
  tasksWaitingOnOwner(): Set<string> {
    // Not DISTINCT: with it SQLite drops the pending index for the type index. The set dedupes.
    const rows = this.db
      .select({ task: roomItems.task })
      .from(roomItems)
      .where(and(inArray(roomItems.type, OWNER_WAIT_TYPES), PENDING))
      .all();
    return new Set(rows.map((r) => r.task));
  }

  /** Tasks with a pending paused card: stopped and waiting for the owner to resume or decide. One query. */
  tasksPausedOnOwner(): Set<string> {
    const rows = this.db
      .select({ task: roomItems.task })
      .from(roomItems)
      .where(and(eq(roomItems.type, "paused"), PENDING))
      .all();
    return new Set(rows.map((r) => r.task));
  }

  /**
   * The items behind `tasksWaitingOnOwner`, in every task, oldest first, and the review cards the
   * captain marked ready to ship (5.18), which the bell lists too. One query.
   */
  waitingOnOwner(): RoomItem[] {
    const shipReady = and(
      eq(roomItems.type, "review"),
      sql`json_extract(${roomItems.payload}, '$.ready') IS NOT NULL`,
    );
    return this.db
      .select()
      .from(roomItems)
      .where(and(or(inArray(roomItems.type, OWNER_WAIT_TYPES), shipReady), PENDING))
      .orderBy(asc(roomItems.at))
      .all()
      .flatMap(readable);
  }

  /**
   * Every pending item that is a decision of the owner's inbox: the cards that wait for an answer,
   * every pending review (ready to ship or not) and every pending pause, oldest first.
   */
  waitingDecisions(): RoomItem[] {
    return this.db
      .select()
      .from(roomItems)
      .where(and(inArray(roomItems.type, [...OWNER_WAIT_TYPES, "review", "paused"]), PENDING))
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

  /** Whether the room holds an item that appeared after `at` (ISO): one indexed probe, no row read. */
  hasItemAfter(task: string, at: string): boolean {
    return (
      this.db
        .select({ one: sql<number>`1` })
        .from(roomItems)
        .where(and(eq(roomItems.task, task), gt(roomItems.at, at)))
        .limit(1)
        .get() !== undefined
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

  /** Keeps only the newest `keep` items of the task's room. */
  trim(task: string, keep: number): void {
    this.db.run(sql`
      DELETE FROM room_items WHERE task = ${task} AND seq <= (
        SELECT seq FROM room_items WHERE task = ${task} ORDER BY seq DESC LIMIT 1 OFFSET ${keep})`);
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
      SELECT coalesce(r.about, r.task) AS task, t.title AS title, t.org AS org, r.id AS item, r.type AS type, r.at AS at,
        coalesce(json_extract(r.payload, '$.agent'), json_extract(r.payload, '$.from')) AS agent,
        snippet(room_search, 0, ${MARK_START}, ${MARK_END}, '…', 14) AS snippet,
        json_extract(r.payload, '$.mentions') AS mentions, json_extract(r.payload, '$.text') AS text
      FROM room_search
      JOIN room_items r ON r.rowid = room_search.rowid
      JOIN tasks t ON t.id = coalesce(r.about, r.task)
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
      snippet: snippetParts(this.snippetOf(row, query)),
    }));
  }

  /**
   * The snippet's marked text. A message with mention tokens is rendered to `@Name` first and cut after, so a cut
   * never shows half a token; any other message keeps the index's own snippet.
   */
  private snippetOf(row: SearchRow, query: string): string {
    const text = row.text ?? "";
    if (mentionedContacts(text).length === 0) return row.snippet;
    const rendered = mentionNames(text, storedMentions(row.mentions), this.contactName);
    return markedWindow(rendered, queryWords(query));
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
  mentions: string | null;
  text: string | null;
}

/** Bracket the matched words in a snippet. They are control characters, which no message holds. */
const MARK_START = "\u0002";
const MARK_END = "\u0003";

export function queryWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.slice(0, 12) ?? []
  );
}

/** A window of the text around its first matched word, with matched words bracketed like the index's own snippet. */
export function markedWindow(text: string, words: readonly string[]): string {
  const lower = text.toLowerCase();
  const firsts = words.map((w) => lower.indexOf(w)).filter((i) => i >= 0);
  const first = firsts.length === 0 ? 0 : Math.min(...firsts);
  const start = Math.max(0, first - 60);
  const end = Math.min(text.length, first + 100);
  const spans: [number, number][] = [];
  for (const w of words) {
    for (
      let at = lower.indexOf(w, start);
      at >= 0 && at + w.length <= end;
      at = lower.indexOf(w, at + w.length)
    )
      spans.push([at, at + w.length]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let out = start > 0 ? "…" : "";
  let pos = start;
  for (const [from, to] of spans) {
    if (from < pos) continue;
    out += `${text.slice(pos, from)}${MARK_START}${text.slice(from, to)}${MARK_END}`;
    pos = to;
  }
  return `${out}${text.slice(pos, end)}${end < text.length ? "…" : ""}`;
}

/** An FTS5 query from typed words: each word quoted, all required, the last one a prefix. Undefined when there are none. */
export function matchQuery(text: string): string | undefined {
  const words = queryWords(text);
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
