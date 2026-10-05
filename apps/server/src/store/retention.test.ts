import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "./index.ts";
import { pruneOld, RETENTION } from "./retention.ts";

const NOW = new Date("2027-01-01T00:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW.getTime() - days * DAY).toISOString();

function task(db: Database.Database, id: string, status: string, updatedDaysAgo: number): void {
  db.prepare(
    "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at) VALUES (?, 't', 'b', 'code', ?, '/t', '[]', 'x', ?)",
  ).run(id, status, ago(updatedDaysAgo));
}

function room(
  db: Database.Database,
  task: string,
  items: [id: string, type: string, payload: object][],
): void {
  const put = db.prepare(
    "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?, 'x')",
  );
  items.forEach(([id, type, payload], i) => {
    put.run(task, id, i + 1, type, JSON.stringify(payload));
  });
}

function audit(db: Database.Database, at: string): void {
  db.prepare(
    "INSERT INTO audit (task, agent, kind, title, decision, by, at, org) VALUES ('T-1', 'a', 'shell', 't', 'allowed', 'owner', ?, 'acme')",
  ).run(at);
}

const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

describe("retention", () => {
  it("deletes what is past its age and keeps the rest, the security log for a year", async () => {
    const store = new Store(":memory:");
    const db = store.raw;
    audit(db, ago(RETENTION.auditDays + 5));
    audit(db, ago(RETENTION.auditDays - 5));
    audit(db, ago(100));
    db.prepare(
      "INSERT INTO autonomy_events (at, kind, text) VALUES (?, 'task', 'old'), (?, 'task', 'new')",
    ).run(ago(RETENTION.autonomyEventsDays + 1), ago(RETENTION.autonomyEventsDays - 1));
    const turn = db.prepare(
      `INSERT INTO turns (at, task, agent, account, tool, auth, input_tokens, output_tokens, reasoning_tokens,
         cache_read_tokens, cache_write_tokens, cost_source, estimated) VALUES (?, 'T-1', 'a', 'x', 't', 'k', 1, 1, 0, 0, 0, 'm', 0)`,
    );
    turn.run(ago(RETENTION.turnsDays + 1));
    turn.run(ago(RETENTION.turnsDays - 1));
    await pruneOld(db, { now: NOW });
    expect(db.prepare("SELECT at FROM audit ORDER BY at").all()).toEqual([
      { at: ago(RETENTION.auditDays - 5) },
      { at: ago(100) },
    ]);
    expect(db.prepare("SELECT text FROM autonomy_events").all()).toEqual([{ text: "new" }]);
    expect(count(db, "turns")).toBe(1);
    store.close();
  });

  it("keeps an unsettled action key and the newest run of each kind, however old", async () => {
    const store = new Store(":memory:");
    const db = store.raw;
    const key = db.prepare("INSERT INTO captain_keys (key, kind, at, settled) VALUES (?, 'ship', ?, ?)");
    key.run("settled-old", ago(400), 1);
    key.run("running-old", ago(400), 0);
    key.run("settled-new", ago(5), 1);
    const run = db.prepare(
      `INSERT INTO captain_runs (org, chore, day, started_at, ended_at, status, trigger)
       VALUES (?, ?, 'd', ?, ?, 'done', 'tick')`,
    );
    run.run("acme", "ship", ago(400), ago(400));
    run.run("acme", "ship", ago(300), ago(300));
    run.run("acme", "cards", ago(250), ago(250));
    run.run("acme", "ship", ago(10), ago(10));
    await pruneOld(db, { now: NOW });
    expect(
      db
        .prepare("SELECT key FROM captain_keys ORDER BY key")
        .all()
        .map((r) => (r as { key: string }).key),
    ).toEqual(["running-old", "settled-new"]);
    // Two old "ship" runs go; the old only "cards" run stays because it is the newest of its kind.
    expect(db.prepare("SELECT chore, started_at AS at FROM captain_runs ORDER BY started_at").all()).toEqual([
      { chore: "cards", at: ago(250) },
      { chore: "ship", at: ago(10) },
    ]);
    store.close();
  });

  it("thins the bulk of a finished task's room and never a card, a message, a pending item or the newest item", async () => {
    const store = new Store(":memory:");
    const db = store.raw;
    task(db, "DONE-OLD", "done", RETENTION.doneRoomBulkDays + 10);
    task(db, "DONE-NEW", "done", 5);
    task(db, "LIVE", "running", RETENTION.doneRoomBulkDays + 10);
    const items: [string, string, object][] = [
      ["tool-1", "tool", { name: "ls" }],
      ["thought-1", "thought", { text: "hm" }],
      ["msg-1", "agent", { text: "done", agent: "a" }],
      ["undo-card", "approval", { state: "approved", commit: "abc" }],
      ["open-card", "approval", { state: "pending" }],
      ["tool-2", "tool", { name: "cat" }],
      ["tool-last", "tool", { name: "last" }],
    ];
    for (const id of ["DONE-OLD", "DONE-NEW", "LIVE"]) room(db, id, items);
    const result = await pruneOld(db, { now: NOW });
    const left = (id: string) =>
      db
        .prepare("SELECT id FROM room_items WHERE task = ? ORDER BY seq")
        .all(id)
        .map((r) => (r as { id: string }).id);
    expect(left("DONE-OLD")).toEqual(["msg-1", "undo-card", "open-card", "tool-last"]);
    expect(left("DONE-NEW")).toHaveLength(items.length);
    expect(left("LIVE")).toHaveLength(items.length);
    expect(result.deleted.room_items).toBe(3);
    // The search index followed the deletes.
    expect(
      db
        .prepare("SELECT count(*) AS n FROM room_search WHERE rowid NOT IN (SELECT rowid FROM room_items)")
        .get(),
    ).toEqual({ n: 0 });
    store.close();
  });

  it("deletes in batches with the event loop handed back in between", async () => {
    const run = async (batchRows: number) => {
      const store = new Store(":memory:");
      for (let i = 0; i < 25; i++) audit(store.raw, ago(RETENTION.auditDays + 10 + i));
      audit(store.raw, ago(1));
      let pauses = 0;
      const result = await pruneOld(store.raw, {
        now: NOW,
        batchRows,
        yieldLoop: async () => {
          pauses += 1;
        },
      });
      expect(result.deleted.audit).toBe(25);
      expect(count(store.raw, "audit")).toBe(1);
      store.close();
      return { batches: result.batches, pauses };
    };
    const small = await run(10);
    const big = await run(1000);
    // 25 rows at 10 a batch is 3 statements (10, 10, 5) where one big batch does it in 1.
    expect(small.batches - big.batches).toBe(2);
    expect(small.pauses - big.pauses).toBe(2);
  });

  it("is safe to run twice", async () => {
    const store = new Store(":memory:");
    audit(store.raw, ago(RETENTION.auditDays + 1));
    expect((await pruneOld(store.raw, { now: NOW })).deleted.audit).toBe(1);
    expect((await pruneOld(store.raw, { now: NOW })).deleted).toEqual({});
    store.close();
  });
});
