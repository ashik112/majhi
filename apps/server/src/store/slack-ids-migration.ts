import { slackPersonId } from "@majhi/shared";
import type Database from "better-sqlite3";

interface IdRow {
  contact: string;
  org: string;
  account: string;
  native: string;
  username: string | null;
  created_at: string;
  us: number;
}

/**
 * Rewrites every stored Slack person to one identity, the user id (see `slackPersonId`): the senders of client
 * messages, the contact identities, the muted lists. Contacts that now share an identity are one person: the
 * oldest contact is kept, the others are folded into it through the merge log, so each can be undone. Running it
 * again changes nothing.
 */
export function stabilizeSlackIds(db: Database.Database): void {
  db.transaction(() => {
    mergeContacts(db);
    rewriteSenders(db);
    rewriteMuted(db);
  })();
}

function mergeContacts(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT i.contact, i.org, i.account, i.native, i.username, c.created_at, c.us
         FROM contact_ids i JOIN contacts c ON c.id = i.contact
        WHERE i.app = 'slack'`,
    )
    .all() as IdRow[];
  const groups = new Map<string, IdRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.org, row.account, slackPersonId(row.native)]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const owners = (group: IdRow[]): string[] =>
    [...new Map(group.map((r) => [r.contact, r])).values()]
      .sort((a, b) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.contact < b.contact ? -1 : 1,
      )
      .map((r) => r.contact);
  const del = db.prepare(
    "DELETE FROM contact_ids WHERE contact = ? AND org = ? AND app = 'slack' AND account = ? AND native = ?",
  );
  const merged = new Set<string>();
  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const order = owners(group);
    // A contact merged away by an earlier group has its identities with the keeper now.
    const keeper = order.find((c) => !merged.has(c));
    if (keeper === undefined) continue;
    for (const other of order) {
      if (other === keeper || merged.has(other)) continue;
      foldInto(db, keeper, other);
      merged.add(other);
    }
    // Settle the keeper's own rows of this person on the one stable id, keeping a handle if any row has one.
    const norm = slackPersonId(first.native);
    const mine = (
      db
        .prepare(
          "SELECT native, username FROM contact_ids WHERE contact = ? AND app = 'slack' AND account = ?",
        )
        .all(keeper, first.account) as { native: string; username: string | null }[]
    ).filter((r) => slackPersonId(r.native) === norm);
    const handle = [...mine, ...group].find((r) => r.username !== null)?.username ?? null;
    const stable = mine.find((r) => r.native === norm);
    for (const r of mine) if (r.native !== norm) del.run(keeper, first.org, first.account, r.native);
    if (stable === undefined) {
      db.prepare(
        "INSERT INTO contact_ids (contact, org, app, account, native, username) VALUES (?, ?, 'slack', ?, ?, ?)",
      ).run(keeper, first.org, first.account, norm, handle);
    } else if (stable.username === null && handle !== null) {
      db.prepare(
        "UPDATE contact_ids SET username = ? WHERE org = ? AND app = 'slack' AND account = ? AND native = ?",
      ).run(handle, first.org, first.account, norm);
    }
  }
}

/** Folds `absorbed` into `kept` the way a merge does, logged with a snapshot so Undo can restore it. */
function foldInto(db: Database.Database, kept: string, absorbed: string): void {
  const gone = db
    .prepare("SELECT id, org, name, tz, lang, us, created_at FROM contacts WHERE id = ?")
    .get(absorbed) as { us: number } | undefined;
  if (gone === undefined) return;
  const ids = db
    .prepare("SELECT app, account, native, username FROM contact_ids WHERE contact = ?")
    .all(absorbed) as { app: string; account: string; native: string; username: string | null }[];
  const normalized = ids.map((i) => (i.app === "slack" ? { ...i, native: slackPersonId(i.native) } : i));
  db.prepare("INSERT INTO contact_merges (kept, absorbed, snapshot, at) VALUES (?, ?, ?, ?)").run(
    kept,
    absorbed,
    JSON.stringify({ contact: gone, ids: normalized }),
    new Date().toISOString(),
  );
  const own = new Set(
    (
      db.prepare("SELECT app, account, native FROM contact_ids WHERE contact = ?").all(kept) as {
        app: string;
        account: string;
        native: string;
      }[]
    ).map((i) => JSON.stringify([i.app, i.account, i.app === "slack" ? slackPersonId(i.native) : i.native])),
  );
  const move = db.prepare(
    "UPDATE contact_ids SET contact = ? WHERE contact = ? AND app = ? AND account = ? AND native = ?",
  );
  const drop = db.prepare(
    "DELETE FROM contact_ids WHERE contact = ? AND app = ? AND account = ? AND native = ?",
  );
  for (const i of ids) {
    const twin = JSON.stringify([i.app, i.account, i.app === "slack" ? slackPersonId(i.native) : i.native]);
    if (own.has(twin)) drop.run(absorbed, i.app, i.account, i.native);
    else move.run(kept, absorbed, i.app, i.account, i.native);
  }
  // Someone marked as one of us stays one of us.
  if (gone.us === 1) db.prepare("UPDATE contacts SET us = 1 WHERE id = ?").run(kept);
  db.prepare("DELETE FROM contacts WHERE id = ?").run(absorbed);
}

function rewriteSenders(db: Database.Database): void {
  const items = db
    .prepare(
      `SELECT rowid, json_extract(payload, '$.sender.id') AS id FROM room_items
        WHERE type = 'client' AND json_extract(payload, '$.external.app') = 'slack'
          AND instr(json_extract(payload, '$.sender.id'), ':') > 0`,
    )
    .all() as { rowid: number; id: string }[];
  const set = db.prepare(
    "UPDATE room_items SET payload = json_set(payload, '$.sender.id', ?) WHERE rowid = ?",
  );
  for (const item of items) set.run(slackPersonId(item.id), item.rowid);
}

function rewriteMuted(db: Database.Database): void {
  const rooms = db
    .prepare(
      `SELECT id, json_extract(client, '$.muted') AS muted FROM tasks
        WHERE client IS NOT NULL AND json_extract(client, '$.app') = 'slack'
          AND json_extract(client, '$.muted') IS NOT NULL`,
    )
    .all() as { id: string; muted: string }[];
  const set = db.prepare("UPDATE tasks SET client = json_set(client, '$.muted', json(?)) WHERE id = ?");
  for (const room of rooms) {
    const list = JSON.parse(room.muted) as unknown;
    if (!Array.isArray(list)) continue;
    const stable = [...new Set(list.map((m) => slackPersonId(String(m))))];
    if (JSON.stringify(stable) !== JSON.stringify(list)) set.run(JSON.stringify(stable), room.id);
  }
}
