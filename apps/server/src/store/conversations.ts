import {
  AUTONOMY_CHAT_BRIEF,
  BOSS_CHAT_BRIEF,
  CAPTAIN_LANE_BRIEF,
  CHAT_BRIEF,
  CLIENT_CHAT_BRIEF,
  type Conversation,
  ConversationSchema,
} from "@majhi/shared";
import { sql } from "drizzle-orm";
import type { Db } from "./db.ts";

/** A last line is cut to this many characters, on the way out of the database. */
const LINE_CHARS = 160;
/** The list never holds more than this many conversations. */
const LIST_LIMIT = 200;

/**
 * What the dock lists: every task room, and each workspace's captain thread. The owner's own chats
 * (the Chats page, the Cmd J chat, the old autonomy chat) are chats, not task rooms. Mirrors
 * `isOwnerChat` minus the captain lane, which is a thread of the dock.
 */
const LISTED = sql`NOT (t.kind = 'chat' AND t.brief IN (${CHAT_BRIEF}, ${BOSS_CHAT_BRIEF}, ${AUTONOMY_CHAT_BRIEF}))`;

interface Row {
  id: string;
  title: string;
  org: string | null;
  brief: string;
  kind: string;
  unread: number;
  agent_at: string | null;
  agent_text: string | null;
  owner_at: string | null;
  owner_text: string | null;
}

/**
 * The owner's read state and the conversation list. A conversation is a task room or a captain
 * thread: both are rooms in `room_items`, keyed by task id, so one query covers them. Unread is the
 * `agent` items after the conversation's mark (`read_marks.read_at`); owner, system and context lines
 * never count. Every number comes from the `(task, type, at)` index, one seek per conversation.
 */
export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  /** Every listed conversation, newest message first. One query, however many there are. */
  list(): Conversation[] {
    return this.read(sql``);
  }

  /** One conversation as it is now, or undefined when it is not listed (no such task, an owner chat, no messages). */
  one(id: string): Conversation | undefined {
    return this.read(sql`AND t.id = ${id}`)[0];
  }

  /**
   * Marks messages up to `upTo` read. The mark never moves back and never passes the newest agent
   * message, so a stale or invented `upTo` cannot hide a reply the owner has not seen. Returns
   * whether the conversation exists and is one the dock lists (a task room or a captain thread).
   */
  markRead(id: string, upTo: string): boolean {
    this.db.run(sql`
      INSERT INTO read_marks (id, read_at, updated_at)
      SELECT ${id}, min(${upTo}, newest), ${new Date().toISOString()}
        FROM (SELECT max(at) AS newest FROM room_items WHERE task = ${id} AND type IN ('agent', 'client'))
       WHERE newest IS NOT NULL
      ON CONFLICT (id) DO UPDATE
         SET read_at = excluded.read_at, updated_at = excluded.updated_at
       WHERE excluded.read_at > read_marks.read_at`);
    return this.exists(id);
  }

  private exists(id: string): boolean {
    return (
      this.db.get<{ one: number }>(sql`
        SELECT 1 AS one FROM tasks t
         WHERE t.id = ${id} AND ${LISTED}`) !== undefined
    );
  }

  /**
   * Task rooms (not done, unless something in them is unread) and captain threads, each with a
   * message. `scope` narrows it to one task.
   */
  private read(scope: ReturnType<typeof sql>): Conversation[] {
    const rows = this.db.all<Row>(sql`
      SELECT t.id AS id, t.title AS title, t.org AS org, t.brief AS brief, t.kind AS kind,
        (SELECT count(*) FROM room_items r
          WHERE r.task = t.id AND r.type IN ('agent', 'client') AND r.at > coalesce(m.read_at, '')) AS unread,
        (SELECT max(r.at) FROM room_items r WHERE r.task = t.id AND r.type IN ('agent', 'client')) AS agent_at,
        (SELECT CASE WHEN r.type = 'client' THEN coalesce(json_extract(r.payload, '$.sender.name'), '') || ': ' ELSE '' END
            || substr(json_extract(r.payload, '$.text'), 1, 600) FROM room_items r
          WHERE r.task = t.id AND r.type IN ('agent', 'client') ORDER BY r.at DESC LIMIT 1) AS agent_text,
        (SELECT max(r.at) FROM room_items r WHERE r.task = t.id AND r.type IN ('owner', 'client-reply')) AS owner_at,
        (SELECT substr(json_extract(r.payload, '$.text'), 1, 600) FROM room_items r
          WHERE r.task = t.id AND r.type IN ('owner', 'client-reply') ORDER BY r.at DESC LIMIT 1) AS owner_text
      FROM tasks t LEFT JOIN read_marks m ON m.id = t.id
      WHERE ${LISTED}
        AND (t.status != 'done' OR EXISTS (
          SELECT 1 FROM room_items r
           WHERE r.task = t.id AND r.type IN ('agent', 'client') AND r.at > coalesce(m.read_at, '')))
        ${scope}`);
    const out: Conversation[] = [];
    for (const row of rows) {
      const last = lastOf(row);
      if (last === undefined) continue;
      out.push(
        ConversationSchema.parse({
          id: row.id,
          kind:
            row.kind === "chat" && row.brief === CAPTAIN_LANE_BRIEF
              ? "captain"
              : row.kind === "chat" && row.brief === CLIENT_CHAT_BRIEF
                ? "client"
                : "task",
          ...(row.org === null ? {} : { org: row.org }),
          title: row.title,
          lastLine: last.line,
          lastAt: last.at,
          unread: row.unread,
        }),
      );
    }
    return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).slice(0, LIST_LIMIT);
  }
}

/** The newer of the newest agent and owner messages, as a one-line preview. */
function lastOf(row: Row): { at: string; line: string } | undefined {
  const agent = row.agent_at === null ? undefined : { at: row.agent_at, line: oneLine(row.agent_text) };
  const owner =
    row.owner_at === null ? undefined : { at: row.owner_at, line: `You: ${oneLine(row.owner_text)}` };
  if (agent === undefined) return owner;
  if (owner === undefined) return agent;
  return owner.at > agent.at ? owner : agent;
}

/** The first non-empty line of a message, cut to fit a list row. */
function oneLine(text: string | null): string {
  const first =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return first.length > LINE_CHARS ? `${first.slice(0, LINE_CHARS - 1)}…` : first;
}
