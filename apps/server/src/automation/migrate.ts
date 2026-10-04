import {
  AutomationActionSchema,
  clockPlaybookSpec,
  defaultPollSeconds,
  OverlapPolicySchema,
  ScheduleSpecSchema,
  WatchDefSchema,
  WatchFireSchema,
  WatchSpecSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { WatchStateSchema } from "../ops/anything/repo.ts";

/**
 * Automations were folded into Playbooks and Watch. This copies what was there, once:
 *
 * - every schedule becomes a clock playbook with the schedule's own id (so its run history, kept in
 *   `automation_runs` under that id, shows on it unchanged), the same time, zone, action and overlap
 *   rule, and the same switch and next run;
 * - every trigger that watches a file or folder, or a URL, becomes a watch with the trigger's action
 *   and its run history moved to it. The other kinds of trigger (task status, merge request, branch,
 *   process exit, usage, command output) have no Watch check yet: they stay where they are and keep
 *   running on the old trigger engine.
 *
 * The old rows are marked with `migrated_to` and are never read again. A row that no longer parses
 * is left alone and unmarked. Safe to run on every start: marked rows are skipped, inserts ignore an
 * id that exists, and the whole pass is one transaction.
 */

export interface MigrationReport {
  schedules: number;
  triggers: number;
  /** Rows left where they were: a row that does not parse, or a trigger of a kind Watch cannot check. */
  left: { schedules: string[]; triggers: string[] };
}

interface ScheduleRow {
  id: string;
  org: string;
  name: string;
  spec: string;
  time_zone: string;
  action: string;
  overlap: string;
  paused: number;
  done: number;
  next_run_at: string | null;
  last_run_id: number | null;
  created_at: string;
  updated_at: string;
}

interface TriggerRow {
  id: string;
  org: string;
  name: string;
  watch: string;
  action: string;
  overlap: string;
  paused: number;
  poll_seconds: number | null;
  baseline: string | null;
  created_at: string;
}

function json(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** `trg-0a1b2c3d4e` becomes `wch-0a1b2c3d4e`. The watch id allows 12 characters after the dash. */
export function watchIdOf(triggerId: string): string {
  return `wch-${triggerId.replace(/^trg-/, "").slice(0, 12)}`;
}

function migrateSchedules(db: Database.Database, report: MigrationReport): void {
  const rows = db
    .prepare("SELECT * FROM schedules WHERE migrated_to IS NULL ORDER BY created_at, id")
    .all() as ScheduleRow[];
  for (const r of rows) {
    const spec = ScheduleSpecSchema.safeParse(json(r.spec));
    const action = AutomationActionSchema.safeParse(json(r.action));
    const overlap = OverlapPolicySchema.safeParse(r.overlap);
    if (!spec.success || !action.success || !overlap.success) {
      report.left.schedules.push(r.id);
      continue;
    }
    let playbook: ReturnType<typeof clockPlaybookSpec>;
    try {
      playbook = clockPlaybookSpec(r.name, {
        org: r.org,
        when: spec.data,
        timeZone: r.time_zone,
        action: action.data,
        overlap: overlap.data,
      });
    } catch {
      report.left.schedules.push(r.id);
      continue;
    }
    db.prepare("INSERT OR IGNORE INTO playbook_custom (id, spec, created_at) VALUES (?, ?, ?)").run(
      r.id,
      JSON.stringify(playbook),
      r.created_at,
    );
    const state = {
      enabled: r.paused !== 1,
      done: r.done === 1,
      next: r.next_run_at,
      ...(r.last_run_id !== null && r.last_run_id > 0 ? { lastRunId: r.last_run_id } : {}),
      touched: r.updated_at,
    };
    db.prepare("INSERT OR IGNORE INTO playbook_state (org, playbook, state) VALUES (?, ?, ?)").run(
      r.org,
      r.id,
      JSON.stringify(state),
    );
    db.prepare("UPDATE schedules SET migrated_to = ? WHERE id = ?").run(r.id, r.id);
    report.schedules += 1;
  }
}

function migrateTriggers(db: Database.Database, report: MigrationReport): void {
  const rows = db
    .prepare("SELECT * FROM triggers WHERE migrated_to IS NULL ORDER BY created_at, id")
    .all() as TriggerRow[];
  for (const r of rows) {
    const watch = WatchSpecSchema.safeParse(json(r.watch));
    const action = AutomationActionSchema.safeParse(json(r.action));
    const overlap = OverlapPolicySchema.safeParse(r.overlap);
    if (!watch.success || !action.success || !overlap.success) {
      report.left.triggers.push(r.id);
      continue;
    }
    const w = watch.data;
    if (w.kind !== "path.changed" && w.kind !== "url.changed") {
      report.left.triggers.push(r.id);
      continue;
    }
    const poll = r.poll_seconds ?? defaultPollSeconds(w.kind);
    const def = WatchDefSchema.safeParse({
      name: r.name.slice(0, 100),
      spec:
        w.kind === "path.changed"
          ? { kind: "path", project: w.project, path: w.path }
          : { kind: "price", url: w.url, mode: "text", compare: [] },
      condition: { type: "changed" },
      everyMin: Math.min(10_080, Math.max(1, Math.ceil(poll / 60))),
      // The action is the point: no incident, no phone, no recovery notice.
      fire: WatchFireSchema.parse({
        alert: { on: false, phone: false },
        run: action.data,
        runOverlap: overlap.data,
        tellOnRecover: false,
      }),
    });
    if (!def.success) {
      report.left.triggers.push(r.id);
      continue;
    }
    // A path's fingerprint is the same text the Watch check makes, so a change made while majhi was
    // down still fires. A page is read differently now: its first look sets the baseline.
    const baseline =
      w.kind === "path.changed"
        ? (json(r.baseline ?? "null") as Record<string, string> | null)?.[""]
        : undefined;
    const state = WatchStateSchema.parse({
      ...(baseline === undefined ? {} : { baseline, signature: baseline }),
    });
    const id = watchIdOf(r.id);
    db.prepare(
      "INSERT OR IGNORE INTO watches (id, org, def, state, paused, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, r.org, JSON.stringify(def.data), JSON.stringify(state), r.paused === 1 ? 1 : 0, r.created_at);
    db.prepare(
      "UPDATE automation_runs SET source_kind = 'watch', source_id = ? WHERE source_kind = 'trigger' AND source_id = ?",
    ).run(id, r.id);
    db.prepare("UPDATE triggers SET migrated_to = ? WHERE id = ?").run(id, r.id);
    report.triggers += 1;
  }
}

/** Copies schedules and triggers into playbooks and watches, once. Returns what it moved. */
export function migrateAutomations(db: Database.Database): MigrationReport {
  const report: MigrationReport = { schedules: 0, triggers: 0, left: { schedules: [], triggers: [] } };
  db.transaction(() => {
    migrateSchedules(db, report);
    migrateTriggers(db, report);
  })();
  return report;
}
