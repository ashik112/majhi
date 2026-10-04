import {
  AutomationActionSchema,
  clockPlaybookSpec,
  OverlapPolicySchema,
  ScheduleSpecSchema,
  triggerWatchDef,
  type WatchDef,
  type WatchSpec,
  WatchSpecSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { type WatchState, WatchStateSchema } from "../ops/anything/repo.ts";

/**
 * Automations were folded into Playbooks and Watch. This copies what was there, once:
 *
 * - every schedule becomes a clock playbook with the schedule's own id (so its run history, kept in
 *   `automation_runs` under that id, shows on it unchanged), the same time, zone, action and overlap
 *   rule, and the same switch and next run;
 * - every trigger becomes a watch with the trigger's action, its settle time and cooldown, and its run
 *   history moved to it (same id with `wch-` for `trg-`). Every kind has a Watch check now: files and
 *   folders, URLs, task status, merge requests, branches, process exits, usage and command output.
 *
 * The old rows are marked with `migrated_to` and are never read again. A row that no longer parses
 * is left alone and unmarked. Safe to run on every start: marked rows are skipped, inserts ignore an
 * id that exists, and the whole pass is one transaction.
 */

export interface MigrationReport {
  schedules: number;
  triggers: number;
  /** Rows left where they were: a row that does not parse. */
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
  settle_seconds: number;
  cooldown_seconds: number;
  baseline: string | null;
  created_at: string;
  updated_at: string;
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

/**
 * What the watch starts from, so a change made while majhi was down still fires and nothing fires
 * twice. A set watch (tasks, processes) keeps the subjects that were on; a branch and a path keep what
 * they last saw; a usage watch that was over stays over. A page, a merge request and a command are read
 * differently now: their first look sets the baseline.
 */
function startState(w: WatchSpec, baseline: Record<string, string> | null, at: string): WatchState {
  if (baseline === null) return WatchStateSchema.parse({});
  switch (w.kind) {
    case "task.status":
    case "process.exit": {
      const on = Object.entries(baseline)
        .filter(([, v]) => v === "on")
        .map(([k]) => k)
        .sort()
        .join(",");
      return WatchStateSchema.parse({ baseline: on, signature: on });
    }
    case "branch.changed":
    case "path.changed": {
      const print = baseline[""];
      return WatchStateSchema.parse(print === undefined ? {} : { baseline: print, signature: print });
    }
    case "usage.over":
      return WatchStateSchema.parse(
        baseline[""] === "on" ? { firing: true, firingSince: at, breachSince: at } : {},
      );
    default:
      return WatchStateSchema.parse({});
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
    let def: WatchDef;
    try {
      def = triggerWatchDef({
        name: r.name,
        watch: watch.data,
        action: action.data,
        overlap: overlap.data,
        pollSeconds: r.poll_seconds,
        settleSeconds: r.settle_seconds,
        cooldownSeconds: r.cooldown_seconds,
      });
    } catch {
      report.left.triggers.push(r.id);
      continue;
    }
    const baseline = r.baseline === null ? null : (json(r.baseline) as Record<string, string> | null);
    const state = startState(watch.data, baseline, r.updated_at);
    const id = watchIdOf(r.id);
    db.prepare(
      "INSERT OR IGNORE INTO watches (id, org, def, state, paused, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, r.org, JSON.stringify(def), JSON.stringify(state), r.paused === 1 ? 1 : 0, r.created_at);
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
