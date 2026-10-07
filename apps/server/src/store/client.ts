import {
  type ChatApp,
  type ChatCursor,
  ChatCursorSchema,
  CLIENT_CHAT_BRIEF,
  type ClientRoom,
  ClientRoomSchema,
  type Contact,
  type ContactIdentity,
  type ContactView,
  ContactViewSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

/** A client room as stored: the task it is and the chat it holds. */
export interface RoomRow {
  id: string;
  /** The workspace the owner linked it to; absent until then. */
  org: string | undefined;
  chat: ClientRoom;
}

interface TaskClientRow {
  id: string;
  org: string | null;
  client: string;
}

function parseRoom(row: TaskClientRow): RoomRow | undefined {
  try {
    const parsed = ClientRoomSchema.safeParse(JSON.parse(row.client));
    return parsed.success ? { id: row.id, org: row.org ?? undefined, chat: parsed.data } : undefined;
  } catch {
    return undefined;
  }
}

interface ContactRow {
  id: string;
  org: string;
  name: string;
  tz: string | null;
  lang: string | null;
  us: number;
}

const toContact = (row: ContactRow): Contact => ({
  id: row.id,
  org: row.org,
  name: row.name,
  ...(row.tz === null ? {} : { tz: row.tz }),
  ...(row.lang === null ? {} : { lang: row.lang }),
  us: row.us === 1,
});

/** What a merge absorbed, kept so Undo can put both back exactly. */
const SnapshotSchema = z.object({
  contact: z.object({
    id: z.string(),
    org: z.string(),
    name: z.string(),
    tz: z.string().nullable(),
    lang: z.string().nullable(),
    us: z.number(),
    created_at: z.string(),
  }),
  ids: z.array(
    z.object({
      app: z.string(),
      account: z.string(),
      native: z.string(),
      username: z.string().nullable().optional(),
    }),
  ),
});

export interface MergeRecord {
  id: number;
  kept: string;
  absorbed: string;
  at: string;
  undoneAt: string | undefined;
}

/**
 * Client rooms, contacts and the read position of a chat app: the rows of migration 179. A room is a
 * task row with a `client` column; a contact is a person in one workspace with the chat identities they
 * have; a merge keeps a snapshot of the contact it absorbed, so Undo restores both exactly.
 */
export class ClientRepo {
  constructor(private readonly sqlite: Database.Database) {}

  // -------------------------------------------------------------------------
  // Rooms

  room(id: string): RoomRow | undefined {
    const row = this.sqlite
      .prepare("SELECT id, org, client FROM tasks WHERE id = ? AND client IS NOT NULL")
      .get(id) as TaskClientRow | undefined;
    return row === undefined ? undefined : parseRoom(row);
  }

  roomOfChat(app: ChatApp, account: string, chat: string): RoomRow | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT id, org, client FROM tasks
          WHERE client IS NOT NULL AND json_extract(client, '$.app') = ?
            AND json_extract(client, '$.account') = ? AND json_extract(client, '$.chat') = ?`,
      )
      .get(app, account, chat) as TaskClientRow | undefined;
    return row === undefined ? undefined : parseRoom(row);
  }

  rooms(): RoomRow[] {
    const rows = this.sqlite
      .prepare("SELECT id, org, client FROM tasks WHERE client IS NOT NULL AND brief = ?")
      .all(CLIENT_CHAT_BRIEF) as TaskClientRow[];
    return rows.flatMap((r) => {
      const room = parseRoom(r);
      return room === undefined ? [] : [room];
    });
  }

  /** The rooms with a reply that waits for the owner. */
  heldRooms(): Set<string> {
    const rows = this.sqlite
      .prepare(
        "SELECT DISTINCT task FROM room_items WHERE type = 'client-reply' AND json_extract(payload, '$.state') = 'held'",
      )
      .all() as { task: string }[];
    return new Set(rows.map((r) => r.task));
  }

  /** Whether the person was asked about the pair already, whatever the owner said. */
  pairAsked(a: string, b: string): boolean {
    return (
      this.sqlite
        .prepare(
          `SELECT 1 FROM room_items WHERE type = 'same-person' AND (
             (json_extract(payload, '$.a') = ? AND json_extract(payload, '$.b') = ?) OR
             (json_extract(payload, '$.a') = ? AND json_extract(payload, '$.b') = ?)) LIMIT 1`,
        )
        .get(a, b, b, a) !== undefined
    );
  }

  setChat(id: string, chat: ClientRoom, at: string): void {
    this.sqlite
      .prepare("UPDATE tasks SET client = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(ClientRoomSchema.parse(chat)), at, id);
  }

  setOrg(id: string, org: string, at: string): void {
    this.sqlite.prepare("UPDATE tasks SET org = ?, updated_at = ? WHERE id = ?").run(org, at, id);
  }

  // -------------------------------------------------------------------------
  // Contacts

  contact(id: string): Contact | undefined {
    const row = this.sqlite
      .prepare("SELECT id, org, name, tz, lang, us FROM contacts WHERE id = ?")
      .get(id) as ContactRow | undefined;
    return row === undefined ? undefined : toContact(row);
  }

  ids(contact: string): ContactIdentity[] {
    return (
      this.sqlite
        .prepare(
          "SELECT app, account, native, username FROM contact_ids WHERE contact = ? ORDER BY app, account, native",
        )
        .all(contact) as { app: ChatApp; account: string; native: string; username: string | null }[]
    ).map((r) => ({
      app: r.app,
      account: r.account,
      native: r.native,
      ...(r.username === null ? {} : { username: r.username }),
    }));
  }

  view(id: string): ContactView | undefined {
    const contact = this.contact(id);
    return contact === undefined ? undefined : ContactViewSchema.parse({ ...contact, ids: this.ids(id) });
  }

  /** The contact of a chat identity in a workspace. */
  byIdentity(org: string, identity: ContactIdentity): Contact | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT c.id, c.org, c.name, c.tz, c.lang, c.us FROM contacts c
           JOIN contact_ids i ON i.contact = c.id
          WHERE i.org = ? AND i.app = ? AND i.account = ? AND i.native = ?`,
      )
      .get(org, identity.app, identity.account, identity.native) as ContactRow | undefined;
    return row === undefined ? undefined : toContact(row);
  }

  /** The contact an app handle names in a workspace (handles are not case sensitive). */
  byUsername(org: string, app: string, account: string, username: string): Contact | undefined {
    const row = this.sqlite
      .prepare(
        `SELECT c.id, c.org, c.name, c.tz, c.lang, c.us FROM contacts c
           JOIN contact_ids i ON i.contact = c.id
          WHERE i.org = ? AND i.app = ? AND i.account = ? AND i.username = ? COLLATE NOCASE`,
      )
      .get(org, app, account, username) as ContactRow | undefined;
    return row === undefined ? undefined : toContact(row);
  }

  /** Keeps the handle the app shows for an identity: it changes, so it is written on each message. */
  setUsername(org: string, identity: ContactIdentity, username: string | undefined): void {
    this.sqlite
      .prepare(
        "UPDATE contact_ids SET username = ? WHERE org = ? AND app = ? AND account = ? AND native = ? AND username IS NOT ?",
      )
      .run(username ?? null, org, identity.app, identity.account, identity.native, username ?? null);
  }

  contactsOf(org: string): ContactView[] {
    const rows = this.sqlite
      .prepare("SELECT id, org, name, tz, lang, us FROM contacts WHERE org = ? ORDER BY created_at, id")
      .all(org) as ContactRow[];
    return rows.map((r) => ContactViewSchema.parse({ ...toContact(r), ids: this.ids(r.id) }));
  }

  /** Makes a contact with its first identity, or returns the one that has the identity already. */
  addContact(contact: Contact, identity: ContactIdentity, at: string): Contact {
    return this.sqlite.transaction(() => {
      const had = this.byIdentity(contact.org, identity);
      if (had !== undefined) return had;
      this.sqlite
        .prepare(
          "INSERT INTO contacts (id, org, name, tz, lang, us, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          contact.id,
          contact.org,
          contact.name,
          contact.tz ?? null,
          contact.lang ?? null,
          contact.us ? 1 : 0,
          at,
        );
      this.sqlite
        .prepare(
          "INSERT INTO contact_ids (contact, org, app, account, native, username) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          contact.id,
          contact.org,
          identity.app,
          identity.account,
          identity.native,
          identity.username ?? null,
        );
      return contact;
    })();
  }

  rename(id: string, name: string): void {
    this.sqlite.prepare("UPDATE contacts SET name = ? WHERE id = ?").run(name, id);
  }

  setUs(id: string, us: boolean): void {
    this.sqlite.prepare("UPDATE contacts SET us = ? WHERE id = ?").run(us ? 1 : 0, id);
  }

  /**
   * Folds `absorbed` into `kept`: its identities move to `kept` and its row goes, after a snapshot of both is
   * written. Returns the merge's id. Both must be in the same workspace and open.
   */
  merge(kept: string, absorbed: string, at: string): number {
    return this.sqlite.transaction(() => {
      const keep = this.contact(kept);
      const gone = this.sqlite
        .prepare("SELECT id, org, name, tz, lang, us, created_at FROM contacts WHERE id = ?")
        .get(absorbed) as (ContactRow & { created_at: string }) | undefined;
      if (keep === undefined || gone === undefined) throw new Error("No such contact");
      if (keep.org !== gone.org) throw new Error("Contacts of two workspaces are never merged");
      if (kept === absorbed) throw new Error("A contact is not merged with itself");
      const snapshot = SnapshotSchema.parse({ contact: gone, ids: this.ids(absorbed) });
      const info = this.sqlite
        .prepare("INSERT INTO contact_merges (kept, absorbed, snapshot, at) VALUES (?, ?, ?, ?)")
        .run(kept, absorbed, JSON.stringify(snapshot), at);
      this.sqlite.prepare("UPDATE contact_ids SET contact = ? WHERE contact = ?").run(kept, absorbed);
      this.sqlite.prepare("DELETE FROM contacts WHERE id = ?").run(absorbed);
      return Number(info.lastInsertRowid);
    })();
  }

  mergeRecord(id: number): MergeRecord | undefined {
    const row = this.sqlite
      .prepare("SELECT id, kept, absorbed, at, undone_at FROM contact_merges WHERE id = ?")
      .get(id) as
      | { id: number; kept: string; absorbed: string; at: string; undone_at: string | null }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: row.id,
          kept: row.kept,
          absorbed: row.absorbed,
          at: row.at,
          undoneAt: row.undone_at ?? undefined,
        };
  }

  /** Puts the absorbed contact and its identities back, and leaves what the kept one gained since. */
  undoMerge(id: number, at: string): void {
    this.sqlite.transaction(() => {
      const row = this.sqlite
        .prepare("SELECT kept, absorbed, snapshot, undone_at FROM contact_merges WHERE id = ?")
        .get(id) as
        | { kept: string; absorbed: string; snapshot: string; undone_at: string | null }
        | undefined;
      if (row === undefined) throw new Error("No such merge");
      if (row.undone_at !== null) throw new Error("That merge was undone already");
      const snap = SnapshotSchema.parse(JSON.parse(row.snapshot));
      this.sqlite
        .prepare(
          "INSERT INTO contacts (id, org, name, tz, lang, us, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          snap.contact.id,
          snap.contact.org,
          snap.contact.name,
          snap.contact.tz,
          snap.contact.lang,
          snap.contact.us,
          snap.contact.created_at,
        );
      const move = this.sqlite.prepare(
        "UPDATE contact_ids SET contact = ?, username = ? WHERE org = ? AND app = ? AND account = ? AND native = ?",
      );
      for (const identity of snap.ids) {
        move.run(
          snap.contact.id,
          identity.username ?? null,
          snap.contact.org,
          identity.app,
          identity.account,
          identity.native,
        );
      }
      this.sqlite.prepare("UPDATE contact_merges SET undone_at = ? WHERE id = ?").run(at, id);
    })();
  }

  // -------------------------------------------------------------------------
  // The read position of a chat app account

  cursor(connection: string): ChatCursor | undefined {
    const row = this.sqlite
      .prepare("SELECT cursor FROM connection_health WHERE connection = ?")
      .get(connection) as { cursor: string | null } | undefined;
    if (row?.cursor == null) return undefined;
    try {
      const parsed = ChatCursorSchema.safeParse(JSON.parse(row.cursor));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  setCursor(connection: string, cursor: ChatCursor, at: string): void {
    // A row made for the cursor alone holds `null` as its health, which the health reader ignores.
    this.sqlite
      .prepare(
        `INSERT INTO connection_health (connection, health, updated_at, cursor) VALUES (?, 'null', ?, ?)
         ON CONFLICT (connection) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(connection, at, JSON.stringify(ChatCursorSchema.parse(cursor)));
  }
}
