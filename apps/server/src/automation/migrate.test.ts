import { describe, expect, it } from "vitest";
import { Catalog } from "../playbooks/catalog.ts";
import { PlaybookRepo } from "../playbooks/repo.ts";
import { createDb } from "../store/db.ts";
import type { ActionHost } from "./actions.ts";
import { createAutomation } from "./index.ts";
import { migrateAutomations, watchIdOf } from "./migrate.ts";
import type { Timers } from "./scheduler.ts";

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
  trig.run(
    "trg-hhhhhhhh88",
    "acme",
    "Build exits",
    '{"kind":"process.exit","task":"ACM-9","on":"failure"}',
    JSON.stringify(startTask),
    "skip",
    0,
    null,
    '{"ACM-9/p1":"on","ACM-9/p2":"off"}',
    "2026-10-01T00:00:07.000Z",
    "2026-10-01T00:00:07.000Z",
  );
  trig.run(
    "trg-iiiiiiii99",
    "acme",
    "Spend",
    '{"kind":"usage.over","metric":"costUsd","period":"today","limit":25}',
    JSON.stringify(runCmd),
    "skip",
    0,
    null,
    '{"":"on"}',
    "2026-10-01T00:00:08.000Z",
    "2026-10-01T00:00:08.000Z",
  );
  trig.run(
    "trg-jjjjjjjj00",
    "acme",
    "Main moves",
    '{"kind":"branch.changed","project":"acme-api","branch":"main"}',
    JSON.stringify(startTask),
    "skip",
    0,
    null,
    '{"":"a1b2c3d4"}',
    "2026-10-01T00:00:09.000Z",
    "2026-10-01T00:00:09.000Z",
  );
  trig.run(
    "trg-kkkkkkkk11",
    "acme",
    "Lint output",
    '{"kind":"command.changed","task":"ACM-9","command":"pnpm lint"}',
    JSON.stringify(runCmd),
    "skip",
    0,
    null,
    null,
    "2026-10-01T00:00:10.000Z",
    "2026-10-01T00:00:10.000Z",
  );
  trig.run(
    "trg-llllllll22",
    "acme",
    "Broken trigger",
    "{not json",
    "{}",
    "skip",
    0,
    null,
    null,
    "2026-10-01T00:00:11.000Z",
    "2026-10-01T00:00:11.000Z",
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
      orgIds: async () => new Set(["acme", "globex"]),
      changed: () => undefined,
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

  it("moves every trigger to a watch with its action, guards and history", () => {
    const db = seed();
    const report = migrateAutomations(db);
    expect(report.triggers).toBe(7);
    // Only the row that does not parse is left, unmarked.
    expect(report.left.triggers).toEqual(["trg-llllllll22"]);

    const watch = (id: string) => {
      const row = db.prepare("SELECT * FROM watches WHERE id = ?").get(watchIdOf(id)) as {
        org: string;
        def: string;
        state: string;
        paused: number;
      };
      return { def: JSON.parse(row.def), state: JSON.parse(row.state), paused: row.paused };
    };

    const path = watch("trg-eeeeeeee55");
    expect(path.def.spec).toEqual({ kind: "path", project: "acme-api", path: "docs" });
    expect(path.def.condition).toEqual({ type: "changed" });
    expect(path.def.fire).toMatchObject({
      alert: { on: false },
      run: runCmd,
      runOverlap: "skip",
      cooldownMin: 5,
      settleMin: 0,
    });
    expect(path.def.everyMin).toBe(1);
    expect(path.state.baseline).toBe("dir 3 abc");

    const url = watch("trg-ffffffff66");
    expect(url.paused).toBe(1);
    expect(url.def).toMatchObject({
      spec: { kind: "price", url: "https://status.acme.example/", mode: "text" },
      everyMin: 2,
      fire: { runOverlap: "allow", settleMin: 0, cooldownMin: 5 },
    });

    const task = watch("trg-gggggggg77");
    expect(task.def.spec).toEqual({ kind: "task", to: "done" });
    expect(task.def.fire.run).toEqual(startTask);
    // Nothing was seen yet: the first look sets the baseline.
    expect(task.state.baseline).toBeUndefined();

    // What was on stays on, so a process that already failed does not fire again.
    const proc = watch("trg-hhhhhhhh88");
    expect(proc.def.spec).toEqual({ kind: "process", task: "ACM-9", on: "failure" });
    expect(proc.state.baseline).toBe("ACM-9/p1");

    const usage = watch("trg-iiiiiiii99");
    expect(usage.def.spec).toEqual({ kind: "usage", metric: "costUsd", period: "today" });
    expect(usage.def.condition).toEqual({ type: "above", value: 25, forMin: 0 });
    expect(usage.state.firing).toBe(true);

    expect(watch("trg-jjjjjjjj00").state.baseline).toBe("a1b2c3d4");
    expect(watch("trg-kkkkkkkk11").def.spec).toEqual({
      kind: "command",
      task: "ACM-9",
      command: "pnpm lint",
    });

    // The run history of the trigger now belongs to the watch.
    expect(
      db.prepare("SELECT source_kind, source_id, status FROM automation_runs WHERE detail = 'boom'").get(),
    ).toEqual({ source_kind: "watch", source_id: watchIdOf("trg-eeeeeeee55"), status: "failed" });
    // Old rows are kept and marked; the row that did not parse is untouched.
    expect(db.prepare("SELECT COUNT(*) AS n FROM triggers").get()).toEqual({ n: 8 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM triggers WHERE migrated_to IS NULL").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM watches").get()).toEqual({ n: 7 });
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

  it("the scheduler runs a migrated schedule once", async () => {
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
      orgIds: async () => new Set(["acme", "globex"]),
      changed: () => undefined,
      now: () => new Date(clock.t),
      timers: { set: () => 0, clear: () => undefined },
    });
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
