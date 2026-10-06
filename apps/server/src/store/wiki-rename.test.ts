import { CaptainChoreSchema } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

const at = "2026-10-01T10:00:00.000Z";

function before(): Database.Database {
  const db = new Database(":memory:");
  migrate(
    db,
    MIGRATIONS.filter((m) => m.id < 173),
  );
  return db;
}

const count = (db: Database.Database, sql: string, ...args: string[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

describe("the map chore becomes the wiki chore", () => {
  it("keeps every captain row under the new name, even where the new name is already there", () => {
    const db = before();
    const action = db.prepare(
      "INSERT INTO captain_actions (key, org, chore, day, at, text, reason, outcome) VALUES (?, 'acme', ?, '2026-10-01', ?, 'Updated the project map', 'merged', 'done')",
    );
    action.run("map:update:acme:2026-10-01", "map", at);
    action.run("map:update:acme:2026-10-02", "map", at);
    action.run("wiki:update:acme:2026-10-02", "wiki", at);
    const run = db.prepare(
      "INSERT INTO captain_runs (org, chore, day, started_at, ended_at, status, trigger) VALUES ('acme', ?, '2026-10-01', ?, ?, ?, 'daily')",
    );
    run.run("map", at, at, "done");
    // A run still open under the old name would block the wiki chore for good.
    run.run("map", at, null, "running");
    db.prepare("INSERT INTO captain_chores (org, chore, failures) VALUES ('acme', 'map', 2)").run();
    db.prepare("INSERT INTO captain_chores (org, chore, failures) VALUES ('globex', 'map', 1)").run();
    db.prepare("INSERT INTO captain_chores (org, chore, failures) VALUES ('globex', 'wiki', 0)").run();
    db.prepare(
      "INSERT INTO captain_cap_asks (org, chore, day, kind, cap, raise_to, text, at) VALUES ('acme', 'map', '2026-10-01', 'tokens', 10, 20, 'More?', ?)",
    ).run(at);

    migrate(db);

    expect(count(db, "SELECT COUNT(*) AS n FROM captain_actions WHERE chore = 'map'")).toBe(0);
    expect(
      db
        .prepare("SELECT key FROM captain_actions ORDER BY key")
        .all()
        .map((r) => (r as { key: string }).key),
    ).toEqual(["wiki:update:acme:2026-10-01", "wiki:update:acme:2026-10-02"]);
    // The action that already had the new name keeps its own row; the duplicate of it goes.
    expect(count(db, "SELECT COUNT(*) AS n FROM captain_actions")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM captain_runs WHERE chore = 'wiki'")).toBe(2);
    expect(
      count(db, "SELECT COUNT(*) AS n FROM captain_runs WHERE chore = 'wiki' AND ended_at IS NULL"),
    ).toBe(0);
    expect(db.prepare("SELECT org, chore, failures FROM captain_chores ORDER BY org").all()).toEqual([
      { org: "acme", chore: "wiki", failures: 2 },
      { org: "globex", chore: "wiki", failures: 0 },
    ]);
    expect(count(db, "SELECT COUNT(*) AS n FROM captain_cap_asks WHERE chore = 'wiki'")).toBe(1);
    // Every stored name still parses as a chore.
    const names = db
      .prepare("SELECT chore FROM captain_runs UNION SELECT chore FROM captain_actions")
      .all() as { chore: string }[];
    for (const { chore } of names) expect(CaptainChoreSchema.safeParse(chore).success).toBe(true);
  });

  it("keeps every playbook row under upkeep-wiki and the owner's off switch for its rule", () => {
    const db = before();
    db.prepare("INSERT INTO playbook_state (org, playbook, state) VALUES ('acme', 'upkeep-map', ?)").run(
      '{"rulesOff":["map-update"]}',
    );
    db.prepare(
      "INSERT INTO playbook_state (org, playbook, state) VALUES ('globex', 'upkeep-map', '{}')",
    ).run();
    db.prepare(
      "INSERT INTO playbook_state (org, playbook, state) VALUES ('globex', 'upkeep-wiki', '{\"x\":1}')",
    ).run();
    const run = db.prepare(
      "INSERT INTO playbook_runs (org, playbook, trigger, status, started_at) VALUES ('acme', 'upkeep-map', 'daily', ?, ?)",
    );
    run.run("done", at);
    run.run("running", at);
    db.prepare(
      "INSERT INTO findings (org, source, title, dedupe_key, by, created_at, updated_at, last_seen, playbook) VALUES ('acme', 'x', 't', 'k', 'owner', ?, ?, ?, 'upkeep-map')",
    ).run(at, at, at);
    db.prepare(
      "INSERT INTO outcomes (subject, kind, org, at, playbook) VALUES ('s', 'k', 'acme', ?, 'upkeep-map')",
    ).run(at);
    db.prepare(
      "INSERT INTO outbound_drafts (org, channel, target, body, status, mode, by, created_at, playbook) VALUES ('acme', 'email', 't', 'b', 'draft', 'ask', 'owner', ?, 'upkeep-map')",
    ).run(at);

    migrate(db);

    for (const table of ["playbook_state", "playbook_runs", "findings", "outcomes", "outbound_drafts"]) {
      expect(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE playbook = 'upkeep-map'`)).toBe(0);
    }
    expect(db.prepare("SELECT org, state FROM playbook_state ORDER BY org").all()).toEqual([
      { org: "acme", state: '{"rulesOff":["wiki-update"]}' },
      { org: "globex", state: '{"x":1}' },
    ]);
    expect(count(db, "SELECT COUNT(*) AS n FROM playbook_runs WHERE playbook = 'upkeep-wiki'")).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM playbook_runs WHERE status = 'running'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM findings WHERE playbook = 'upkeep-wiki'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM outcomes WHERE playbook = 'upkeep-wiki'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) AS n FROM outbound_drafts WHERE playbook = 'upkeep-wiki'")).toBe(1);
  });
});
