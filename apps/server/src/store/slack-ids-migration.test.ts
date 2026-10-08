import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 183: one Slack person is one identity, duplicates merge through the merge log, and a second run changes nothing. */

function seeded() {
  const db = new Database(":memory:");
  migrate(
    db,
    MIGRATIONS.filter((m) => m.id < 183),
  );
  const contact = db.prepare(
    "INSERT INTO contacts (id, org, name, us, created_at) VALUES (?, 'acme', ?, ?, ?)",
  );
  const ident = db.prepare(
    "INSERT INTO contact_ids (contact, org, app, account, native, username) VALUES (?, 'acme', ?, 'ws', ?, ?)",
  );
  contact.run("ct-old", "Sara Khan", 0, "2026-10-01T00:00:00Z");
  contact.run("ct-mid", "Sara", 1, "2026-10-02T00:00:00Z");
  contact.run("ct-new", "Sara", 0, "2026-10-03T00:00:00Z");
  contact.run("ct-tg", "Omar", 0, "2026-10-03T00:00:00Z");
  ident.run("ct-old", "slack", "T01ACME:U1SARA", null);
  ident.run("ct-mid", "slack", ":U1SARA", "sara");
  ident.run("ct-new", "slack", "U1SARA", null);
  ident.run("ct-tg", "telegram", "T01ACME:99", null);
  return db;
}

it("rewrites Slack ids to the user id, merges duplicate contacts into the oldest and logs each merge", () => {
  const db = seeded();
  db.prepare(
    "INSERT INTO tasks (id, title, brief, kind, status, folder, team, client, created_at, updated_at) VALUES ('t1','t','b','chat','review','/t/1','[]',?,'x','x')",
  ).run(
    JSON.stringify({
      app: "slack",
      account: "ws",
      chat: "C1",
      muted: ["T01ACME:U2OMAR", "U2OMAR", ":U3LEE"],
    }),
  );
  const item = (id: string, seq: number, sender: string) =>
    db
      .prepare(
        "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES ('t1', ?, ?, 'client', ?, 'x')",
      )
      .run(id, seq, JSON.stringify({ external: { app: "slack" }, sender: { id: sender } }));
  item("a", 1, "T01ACME:U1SARA");
  item("b", 2, ":U1SARA");
  item("c", 3, "U1SARA");
  expect(migrate(db)).toContain(183);
  expect(db.prepare("SELECT contact, native, username FROM contact_ids ORDER BY app, native").all()).toEqual([
    { contact: "ct-old", native: "U1SARA", username: "sara" },
    { contact: "ct-tg", native: "T01ACME:99", username: null },
  ]);
  expect(db.prepare("SELECT id, us FROM contacts ORDER BY id").all()).toEqual([
    { id: "ct-old", us: 1 },
    { id: "ct-tg", us: 0 },
  ]);
  expect(db.prepare("SELECT json_extract(client, '$.muted') AS m FROM tasks").get()).toEqual({
    m: '["U2OMAR","U3LEE"]',
  });
  expect(
    db.prepare("SELECT DISTINCT json_extract(payload, '$.sender.id') AS id FROM room_items").all(),
  ).toEqual([{ id: "U1SARA" }]);
  expect(db.prepare("SELECT kept, absorbed FROM contact_merges ORDER BY id").all()).toEqual([
    { kept: "ct-old", absorbed: "ct-mid" },
    { kept: "ct-old", absorbed: "ct-new" },
  ]);
});

it("changes nothing when it runs a second time", () => {
  const db = seeded();
  migrate(db);
  const dump = () => ({
    ids: db.prepare("SELECT * FROM contact_ids ORDER BY native").all(),
    contacts: db.prepare("SELECT * FROM contacts ORDER BY id").all(),
    merges: db.prepare("SELECT count(*) AS n FROM contact_merges").get(),
  });
  const once = dump();
  const m = MIGRATIONS.find((x) => x.id === 183);
  m?.run?.(db);
  expect(dump()).toEqual(once);
});
