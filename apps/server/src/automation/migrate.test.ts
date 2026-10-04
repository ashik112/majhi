import { describe, expect, it } from "vitest";
import { Catalog } from "../playbooks/catalog.ts";
import { PlaybookRepo } from "../playbooks/repo.ts";
import { createDb } from "../store/db.ts";
import type { ActionHost } from "./actions.ts";
import { createAutomation } from "./index.ts";
import { migrateAutomations, watchIdOf } from "./migrate.ts";
import type { Timers } from "./scheduler.ts";
import type { WatchHost } from "./triggers/observe.ts";

/** Schedules become clock playbooks and path and URL triggers become watches: nothing lost, once. */

const startTask = { kind: "task.start", project: "acme-api", title: "Nightly", text: "Run the checks." };
const runCmd = { kind: "process.run", task: "ACM-9", command: "pnpm test" };

function seed() {
  const { sqlite } = createDb(":memory:");
  const sched = sqlite.prepare(
    `INSERT INTO schedules (id, org, name, spec, time_zone, action, overlap, paused, done, next_run_at, last_run_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sched.run(
    "sch-aaaaaa1111",
    "acme",
    "Nightly",
    '{"kind":"interval","every":1,"unit":"hours"}',
    "Europe/Berlin",
    JSON.stringify(startTask),
    "skip",
    0,
    0,
    "2026-10-04T11:00:00.000Z",
    2,
    "2026-10-01T00:00:00.000Z",
    "2026-10-02T00:00:00.000Z",
  );
  sched.run(
    "sch-bbbbbb2222",
    "acme",
    "Paused tests",
    '{"kind":"cron","expression":"0 9 * * 1-5"}',
    "UTC",
    JSON.stringify(runCmd),
    "allow",
    1,
    0,
    null,
    null,
    "2026-10-01T00:00:01.000Z",
    "2026-10-01T00:00:01.000Z",
  );
  sched.run(
    "sch-cccccc3333",
    "globex",
    "One off",
    '{"kind":"once","at":"2026-10-03T09:00"}',
    "UTC",
    JSON.stringify(startTask),
    "skip",
    0,
    1,
    null,
    3,
    "2026-10-01T00:00:02.000Z",
    "2026-10-03T09:00:00.000Z",
  );
  sched.run(
    "sch-dddddd4444",
    "acme",
    "Broken",
    "{not json",
    "UTC",
    "{}",
    "skip",
    0,
    0,
    null,
    null,
    "2026-10-01T00:00:03.000Z",
    "2026-10-01T00:00:03.000Z",
  );
  const trig = sqlite.prepare(
    `INSERT INTO triggers (id, org, name, watch, action, overlap, paused, poll_seconds, settle_seconds, cooldown_seconds, baseline, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 300, ?, ?, ?)`,
  );
  trig.run(
    "trg-eeeeeeee55",
    "acme",
    "Docs changed",
    '{"kind":"path.changed","project":"acme-api","path":"docs"}',
    JSON.stringify(runCmd),
    "skip",
    0,
    null,
    '{"":"dir 3 abc"}',
    "2026-10-01T00:00:04.000Z",
    "2026-10-01T00:00:04.000Z",
  );
  trig.run(
    "trg-ffffffff66",
    "acme",
    "Status page",
    '{"kind":"url.changed","url":"https://status.acme.example/"}',
    JSON.stringify({ kind: "room.post", task: "ACM-9", text: "{{event}}" }),
    "allow",
    1,
    120,
    null,
    "2026-10-01T00:00:05.000Z",
    "2026-10-01T00:00:05.000Z",
  );
  trig.run(
    "trg-gggggggg77",
    "acme",
    "Task done",
    '{"kind":"task.status","to":"done"}',
    JSON.stringify(startTask),
    "skip",
    0,
    null,
    null,
    "2026-10-01T00:00:06.000Z",
    "2026-10-01T00:00:06.000Z",
  );
  const run = sqlite.prepare(
    "INSERT INTO automation_runs (source_kind, source_id, org, started_at, ended_at, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  run.run(
    "schedule",
    "sch-aaaaaa1111",
    "acme",
    "2026-10-04T09:00:00.000Z",
    "2026-10-04T09:05:00.000Z",
    "ok",
    "Task ACM-1 is done.",
  );
  run.run(
    "schedule",
    "sch-aaaaaa1111",
    "acme",
    "2026-10-04T10:00:00.000Z",
    null,
    "running",
    "Started task ACM-2",
  );
  run.run(
    "trigger",
    "trg-eeeeeeee55",
    "acme",
    "2026-10-04T08:00:00.000Z",
    "2026-10-04T08:00:09.000Z",
    "failed",
    "boom",
  );
  return sqlite;
}

describe("automations folded into playbooks and watch", () => {
  it("copies every schedule into a clock playbook with the same id, time, action, switch and history", () => {
    const db = seed();
    const report = migrateAutomations(db);
    expect(report.schedules).toBe(3);
    expect(report.left.schedules).toEqual(["sch-dddddd4444"]);

    const customs = new PlaybookRepo(db).customs().map((c) => c.id);
    expect(customs.sort()).toEqual(["sch-aaaaaa1111", "sch-bbbbbb2222", "sch-cccccc3333"]);

    // Read them back through the clock side, as the scheduler does.
    const auto = createAutomation({
      db,
      catalog: new Catalog(),
      host: {} as ActionHost,
      watch: {} as WatchHost,
      orgIds: async () => new Set(["acme", "globex"]),
      changed: () => undefined,
      triggersChanged: () => undefined,
      timers: { set: () => 0, clear: () => undefined } satisfies Timers,
    });
    const nightly = auto.schedules.peek("sch-aaaaaa1111");
    expect(nightly).toMatchObject({
      org: "acme",
      name: "Nightly",
      timeZone: "Europe/Berlin",
      overlap: "skip",
      paused: false,
      done: false,
      nextRunAt: "2026-10-04T11:00:00.000Z",
      spec: { kind: "interval", every: 1, unit: "hours" },
      action: startTask,
    });
    expect(nightly?.lastRun?.id).toBe(2);
    expect(auto.schedules.recent("sch-aaaaaa1111", 10).map((r) => r.status)).toEqual(["running", "ok"]);
    expect(auto.schedules.peek("sch-bbbbbb2222")).toMatchObject({
      paused: true,
      overlap: "allow",
      nextRunAt: null,
    });
    expect(auto.schedules.peek("sch-cccccc3333")).toMatchObject({ done: true, org: "globex" });
    // The one that did not parse was left alone, not deleted.
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE migrated_to IS NULL").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM schedules").get()).toEqual({ n: 4 });
  });

  it("moves path and URL triggers to watches with their action and history, and leaves the other kinds running", () => {
    const db = seed();
    const report = migrateAutomations(db);
    expect(report.triggers).toBe(2);
    expect(report.left.triggers).toEqual(["trg-gggggggg77"]);

    const path = db.prepare("SELECT * FROM watches WHERE id = ?").get(watchIdOf("trg-eeeeeeee55")) as {
      org: string;
      def: string;
      state: string;
      paused: number;
    };
    const def = JSON.parse(path.def);
    expect(def.spec).toEqual({ kind: "path", project: "acme-api", path: "docs" });
    expect(def.condition).toEqual({ type: "changed" });
    expect(def.fire).toMatchObject({ alert: { on: false }, run: runCmd, runOverlap: "skip" });
    expect(def.everyMin).toBe(1);
    expect(JSON.parse(path.state).baseline).toBe("dir 3 abc");

    const url = db.prepare("SELECT * FROM watches WHERE id = ?").get(watchIdOf("trg-ffffffff66")) as {
      def: string;
      paused: number;
    };
    expect(url.paused).toBe(1);
    expect(JSON.parse(url.def)).toMatchObject({
      spec: { kind: "price", url: "https://status.acme.example/", mode: "text" },
      everyMin: 2,
      fire: { runOverlap: "allow" },
    });

    // The run history of the trigger now belongs to the watch.
    expect(
      db.prepare("SELECT source_kind, source_id, status FROM automation_runs WHERE detail = 'boom'").get(),
    ).toEqual({ source_kind: "watch", source_id: watchIdOf("trg-eeeeeeee55"), status: "failed" });
    // The task-status trigger stays where it was, unmarked, and the old engine still sees it.
    expect(db.prepare("SELECT migrated_to FROM triggers WHERE id = 'trg-gggggggg77'").get()).toEqual({
      migrated_to: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM triggers").get()).toEqual({ n: 3 });
  });

  it("is safe to run again: nothing is copied twice and nothing changes", () => {
    const db = seed();
    migrateAutomations(db);
    const snapshot = JSON.stringify([
      db.prepare("SELECT * FROM playbook_custom ORDER BY id").all(),
      db.prepare("SELECT * FROM playbook_state ORDER BY playbook").all(),
      db.prepare("SELECT * FROM watches ORDER BY id").all(),
      db.prepare("SELECT * FROM automation_runs ORDER BY id").all(),
    ]);
    const again = migrateAutomations(db);
    expect(again.schedules).toBe(0);
    expect(again.triggers).toBe(0);
    migrateAutomations(db);
    expect(
      JSON.stringify([
        db.prepare("SELECT * FROM playbook_custom ORDER BY id").all(),
        db.prepare("SELECT * FROM playbook_state ORDER BY playbook").all(),
        db.prepare("SELECT * FROM watches ORDER BY id").all(),
        db.prepare("SELECT * FROM automation_runs ORDER BY id").all(),
      ]),
    ).toBe(snapshot);
  });

  it("the old trigger engine no longer sees a migrated trigger, and the scheduler runs a migrated schedule once", async () => {
    const db = seed();
    const started: string[] = [];
    const host = {
      projects: async () => [{ id: "acme-api", org: "acme", aliases: [] }],
      agent: async () => undefined,
      task: () => undefined,
      startTask: async ({ text }: { text: string }) => {
        started.push(text);
        return { id: "ACM-3" };
      },
    } as unknown as ActionHost;
    const clock = { t: Date.parse("2026-10-04T11:30:00Z") };
    const auto = createAutomation({
      db,
      catalog: new Catalog(),
      host,
      watch: {} as WatchHost,
      orgIds: async () => new Set(["acme", "globex"]),
      changed: () => undefined,
      triggersChanged: () => undefined,
      now: () => new Date(clock.t),
      timers: { set: () => 0, clear: () => undefined },
    });
    expect((await auto.triggers.list()).map((t) => t.id)).toEqual(["trg-gggggggg77"]);
    await auto.scheduler.tick();
    await auto.scheduler.tick();
    // The migrated schedule was due and ran once, however many ticks came after.
    const runs = auto.schedules.recent("sch-aaaaaa1111", 10);
    expect(runs[0]?.taskId).toBe("ACM-3");
    expect(started).toHaveLength(1);
    // The next slot counted from now, so the second tick found nothing due.
    expect(auto.schedules.peek("sch-aaaaaa1111")?.nextRunAt).toBe("2026-10-04T12:30:00.000Z");
    expect(runs).toHaveLength(3);
  });
});
