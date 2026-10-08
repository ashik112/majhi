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
import { parseBody, renderPlain } from "../chat/format.ts";
import type { Db } from "./db.ts";

/** A last line is cut to this many characters, on the way out of the database. */
const LINE_CHARS = 160;
/** The list never holds more than this many conversations. */
const LIST_LIMIT = 200;

/**
 * What the list holds: every task room, each workspace's captain thread, client chats and the chats
 * the owner started with an agent. The old autonomy chat is left out (the captain threads replace it), and so is a captain's on-call lane: it is the Urgent tab of that workspace's captain thread.
 */
const LISTED = sql`NOT (t.kind = 'chat' AND t.brief = ${AUTONOMY_CHAT_BRIEF})
  AND t.id NOT IN (SELECT chat FROM captain_lanes WHERE job = 'reacting')`;
/** A chat that became a task: its origin names itself. It stays one conversation, listed as the chat it was. */
const PROMOTED = sql`(json_extract(t.origin, '$.kind') = 'chat' AND json_extract(t.origin, '$.room') = t.id)`;
/** The chats the owner started with an agent: they stay listed after they are done. */
const AGENT_CHAT = sql`((t.kind = 'chat' AND t.brief IN (${CHAT_BRIEF}, ${BOSS_CHAT_BRIEF})) OR ${PROMOTED})`;

/**
 * Whether a client's message counts as unread, by the chat's Notify setting: every message, only what needs the
 * owner (it waits for them, or failed), or none. An urgent one always counts. Used where `r` is the message and `t` its room.
 */
const NOTIFIES = sql`(json_extract(r.payload, '$.outcome.urgent') = 1
  OR coalesce(json_extract(t.client, '$.notify'), 'needs-me') = 'every'
  OR (coalesce(json_extract(t.client, '$.notify'), 'needs-me') = 'needs-me'
      AND json_extract(r.payload, '$.outcome.state') IN ('waits', 'failed')))`;

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
  /** Who wrote the newest owner-side message: `captain`, `majhi` or `you`. */
  owner_by: string | null;
  app: string | null;
  agent: string | null;
  unlinked: number | null;
  created_at: string;
  archived: number;
  promoted: number;
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

  /** The listed conversations with a message that holds the words (case ignored). Not only the newest line. */
  matching(query: string): string[] {
    const like = `%${query.toLowerCase().split("\\").join("\\\\").split("%").join("\\%").split("_").join("\\_")}%`;
    // A captain line tagged to a task belongs to that task, so it finds the task, not the thread.
    const rows = this.db.all<{ task: string }>(sql`
      SELECT DISTINCT t.id AS task FROM room_items r JOIN tasks t ON t.id = coalesce(r.about, r.task)
       WHERE r.type IN ('agent', 'owner', 'client', 'client-reply') AND ${LISTED}
         AND lower(json_extract(r.payload, '$.text')) LIKE ${like} ESCAPE '\\'
       LIMIT ${LIST_LIMIT}`);
    return rows.map((r) => r.task);
  }

  /** Hides a conversation or brings it back. False when it is not a listed conversation. */
  archive(id: string, archived: boolean): boolean {
    if (!this.exists(id)) return false;
    if (archived) {
      this.db.run(sql`
        INSERT INTO conversation_archive (id, archived_at) VALUES (${id}, ${new Date().toISOString()})
        ON CONFLICT (id) DO NOTHING`);
    } else {
      this.db.run(sql`DELETE FROM conversation_archive WHERE id = ${id}`);
    }
    return true;
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
        FROM (SELECT max(at) AS newest FROM room_items
               WHERE (task = ${id} AND about IS NULL OR about = ${id}) AND type IN ('agent', 'client'))
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
   * Task rooms (not done, unless something in them is unread), captain threads, client chats and
   * agent chats, each with a message. `scope` narrows it to one task.
   */
  private read(scope: ReturnType<typeof sql>): Conversation[] {
    const rows = this.db.all<Row>(sql`
      SELECT t.id AS id, t.title AS title, t.org AS org, t.brief AS brief, t.kind AS kind,
        json_extract(t.client, '$.app') AS app, json_extract(t.team, '$[0]') AS agent,
        json_extract(t.client, '$.archived') AS unlinked, t.created_at AS created_at,
        (a.archived_at IS NOT NULL) AS archived, (${PROMOTED}) AS promoted,
        (SELECT count(*) FROM room_items r
          WHERE r.task = t.id AND r.about IS NULL AND r.type IN ('agent', 'client') AND r.at > coalesce(m.read_at, '')
            AND (r.type = 'agent' OR ${NOTIFIES}))
          + (SELECT count(*) FROM room_items a
              WHERE a.about = t.id AND a.type = 'agent' AND a.at > coalesce(m.read_at, '')) AS unread,
        (SELECT max(r.at) FROM room_items r WHERE r.task = t.id AND r.about IS NULL AND r.type IN ('agent', 'client')) AS agent_at,
        (SELECT CASE WHEN r.type = 'client' THEN coalesce(json_extract(r.payload, '$.sender.name'), '') || ': ' ELSE '' END
            || substr(json_extract(r.payload, '$.text'), 1, 600) FROM room_items r
          WHERE r.task = t.id AND r.about IS NULL AND r.type IN ('agent', 'client') ORDER BY r.at DESC LIMIT 1) AS agent_text,
        (SELECT max(r.at) FROM room_items r WHERE r.task = t.id AND r.type IN ('owner', 'client-reply')
            AND (r.type = 'owner' OR json_extract(r.payload, '$.state') = 'sent')) AS owner_at,
        (SELECT substr(json_extract(r.payload, '$.text'), 1, 600) FROM room_items r
          WHERE r.task = t.id AND r.type IN ('owner', 'client-reply')
            AND (r.type = 'owner' OR json_extract(r.payload, '$.state') = 'sent') ORDER BY r.at DESC LIMIT 1) AS owner_text,
        (SELECT CASE WHEN json_extract(r.payload, '$.by') = 'captain' AND json_extract(r.payload, '$.as') IS NULL THEN 'captain'
                     WHEN json_extract(r.payload, '$.by') = 'majhi' THEN 'majhi' ELSE 'you' END FROM room_items r
          WHERE r.task = t.id AND r.type IN ('owner', 'client-reply')
            AND (r.type = 'owner' OR json_extract(r.payload, '$.state') = 'sent') ORDER BY r.at DESC LIMIT 1) AS owner_by
      FROM tasks t LEFT JOIN read_marks m ON m.id = t.id LEFT JOIN conversation_archive a ON a.id = t.id
      WHERE ${LISTED}
        AND (t.status != 'done' OR ${AGENT_CHAT} OR EXISTS (
          SELECT 1 FROM room_items r
           WHERE r.task = t.id AND r.type IN ('agent', 'client') AND r.at > coalesce(m.read_at, '')))
        ${scope}`);
    const out: Conversation[] = [];
    for (const row of rows) {
      // A chat linked and not written in yet is still listed: the owner linked it and looks for it.
      const last =
        lastOf(row) ??
        (kindOf(row) === "client" && row.org !== null
          ? { at: row.created_at, line: "No messages yet" }
          : undefined);
      if (last === undefined) continue;
      out.push(
        ConversationSchema.parse({
          id: row.id,
          kind: kindOf(row),
          ...(row.org === null ? {} : { org: row.org }),
          title: row.title,
          lastLine: last.line,
          lastAt: last.at,
          unread: row.unread,
          ...(kindOf(row) === "client" && row.app !== null ? { app: row.app } : {}),
          ...(kindOf(row) === "agent" && row.agent !== null ? { agent: row.agent } : {}),
          ...(row.unlinked === 1 ? { unlinked: true } : {}),
          ...(row.archived === 1 ? { archived: true } : {}),
        }),
      );
    }
    return out.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).slice(0, LIST_LIMIT);
  }
}

function kindOf(row: Row): Conversation["kind"] {
  if (row.promoted === 1) return "agent";
  if (row.kind !== "chat") return "task";
  if (row.brief === CAPTAIN_LANE_BRIEF) return "captain";
  if (row.brief === CLIENT_CHAT_BRIEF) return "client";
  return "agent";
}

/** The newer of the newest agent and owner messages, as a one-line preview. */
function lastOf(row: Row): { at: string; line: string } | undefined {
  const agent = row.agent_at === null ? undefined : { at: row.agent_at, line: oneLine(row.agent_text) };
  // The writer is named as recorded: a reply the captain sent reads "Captain:", the owner's own "You:".
  const who = row.owner_by === "captain" ? "Captain" : row.owner_by === "majhi" ? "majhi" : "You";
  const owner =
    row.owner_at === null ? undefined : { at: row.owner_at, line: `${who}: ${oneLine(row.owner_text)}` };
  if (agent === undefined) return owner;
  if (owner === undefined) return agent;
  return owner.at > agent.at ? owner : agent;
}

/** The first non-empty line of a message as plain words (its Markdown read, not shown), cut to fit a list row. */
function oneLine(text: string | null): string {
  const first =
    plain(text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "";
  return first.length > LINE_CHARS ? `${first.slice(0, LINE_CHARS - 1)}…` : first;
}

/** A message's words without its markup. A mention the list cannot name reads as "someone". */
function plain(text: string): string {
  try {
    return renderPlain(parseBody(text), () => ({ name: "someone", native: undefined, username: undefined }));
  } catch {
    return text;
  }
}
