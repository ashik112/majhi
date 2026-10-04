import {
  type AutomationAction,
  type ClockAction,
  CustomPlaybookSpecSchema,
  clockPlaybookSpec,
  type OverlapPolicy,
  type PlaybookState,
  PlaybookStateSchema,
  type ScheduleSpec,
} from "@majhi/shared";
import type Database from "better-sqlite3";

/**
 * A schedule is a clock playbook: its definition is a `playbook_custom` row whose spec has a `clock`,
 * and its switch, next run and last run live in `playbook_state` (org = the clock's org). The old
 * `schedules` table is only read by the migration (`migrate.ts`).
 */

export interface ScheduleRow {
  id: string;
  org: string;
  name: string;
  spec: ScheduleSpec;
  timeZone: string;
  action: AutomationAction;
  overlap: OverlapPolicy;
  /** The playbook's switch is off. */
  paused: boolean;
  /** A `once` schedule that has run. */
  done: boolean;
  /** UTC ISO. Null when paused or done. */
  nextRunAt: string | null;
  lastRunId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** What `update` may change. `undefined` leaves a column alone. */
export type SchedulePatch = Partial<
  Pick<
    ScheduleRow,
    "name" | "spec" | "timeZone" | "action" | "overlap" | "paused" | "done" | "nextRunAt" | "lastRunId"
  >
>;

interface CustomRow {
  id: string;
  spec: string;
  created_at: string;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export class ScheduleRepo {
  constructor(private readonly db: Database.Database) {}

  /** The spec and clock of a row, or undefined when it is not a clock playbook (or is damaged). */
  private parse(r: CustomRow): { name: string; clock: ClockAction } | undefined {
    const spec = CustomPlaybookSpecSchema.safeParse(parseJson(r.spec));
    if (!spec.success || spec.data.clock === undefined) return undefined;
    return { name: spec.data.name, clock: spec.data.clock };
  }

  private state(org: string, id: string): PlaybookState {
    const row = this.db
      .prepare("SELECT state FROM playbook_state WHERE org = ? AND playbook = ?")
      .get(org, id) as { state: string } | undefined;
    if (row === undefined) return {};
    return PlaybookStateSchema.safeParse(parseJson(row.state)).data ?? {};
  }

  private writeState(org: string, id: string, state: PlaybookState): void {
    this.db
      .prepare(
        `INSERT INTO playbook_state (org, playbook, state) VALUES (?, ?, ?)
         ON CONFLICT(org, playbook) DO UPDATE SET state = excluded.state`,
      )
      .run(org, id, JSON.stringify(state));
  }

  private row(r: CustomRow): ScheduleRow | undefined {
    const parsed = this.parse(r);
    if (parsed === undefined) return undefined;
    const { clock } = parsed;
    const state = this.state(clock.org, r.id);
    return {
      id: r.id,
      org: clock.org,
      name: parsed.name,
      spec: clock.when,
      timeZone: clock.timeZone,
      action: clock.action,
      overlap: clock.overlap,
      paused: state.enabled !== true,
      done: state.done === true,
      nextRunAt: state.next ?? null,
      lastRunId: state.lastRunId ?? null,
      createdAt: r.created_at,
      updatedAt: state.touched ?? r.created_at,
    };
  }

  /** Writes a new clock playbook: its definition and its switch. */
  insert(row: ScheduleRow): void {
    const spec = clockPlaybookSpec(row.name, {
      org: row.org,
      when: row.spec,
      timeZone: row.timeZone,
      action: row.action,
      overlap: row.overlap,
    });
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO playbook_custom (id, spec, created_at) VALUES (?, ?, ?)")
        .run(row.id, JSON.stringify(spec), row.createdAt);
      this.writeState(row.org, row.id, {
        enabled: !row.paused,
        done: row.done,
        next: row.nextRunAt,
        lastRunId: row.lastRunId,
        touched: row.updatedAt,
      });
    })();
  }

  get(id: string): ScheduleRow | undefined {
    const r = this.db.prepare("SELECT id, spec, created_at FROM playbook_custom WHERE id = ?").get(id) as
      | CustomRow
      | undefined;
    return r === undefined ? undefined : this.row(r);
  }

  /** Oldest first, optionally for one org. */
  list(org?: string): ScheduleRow[] {
    const rows = this.db
      .prepare("SELECT id, spec, created_at FROM playbook_custom ORDER BY created_at, id")
      .all() as CustomRow[];
    return rows.flatMap((r) => {
      const row = this.row(r);
      return row === undefined || (org !== undefined && row.org !== org) ? [] : [row];
    });
  }

  update(id: string, patch: SchedulePatch, updatedAt: string): void {
    const r = this.db.prepare("SELECT id, spec, created_at FROM playbook_custom WHERE id = ?").get(id) as
      | CustomRow
      | undefined;
    const current = r === undefined ? undefined : this.parse(r);
    if (r === undefined || current === undefined) return;
    const org = current.clock.org;
    const clock: ClockAction = {
      ...current.clock,
      ...(patch.spec === undefined ? {} : { when: patch.spec }),
      ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
      ...(patch.action === undefined ? {} : { action: patch.action }),
      ...(patch.overlap === undefined ? {} : { overlap: patch.overlap }),
    };
    const state = this.state(org, id);
    const next: PlaybookState = {
      ...state,
      ...(patch.paused === undefined ? {} : { enabled: !patch.paused }),
      ...(patch.done === undefined ? {} : { done: patch.done }),
      ...(patch.nextRunAt === undefined ? {} : { next: patch.nextRunAt }),
      ...(patch.lastRunId === undefined ? {} : { lastRunId: patch.lastRunId }),
      touched: updatedAt,
    };
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE playbook_custom SET spec = ? WHERE id = ?")
        .run(JSON.stringify(clockPlaybookSpec(patch.name ?? current.name, clock)), id);
      this.writeState(org, id, next);
    })();
  }

  /** Removes the playbook with its state and its playbook runs. Run history is the service's to remove. */
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM playbook_custom WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM playbook_state WHERE playbook = ?").run(id);
      this.db.prepare("DELETE FROM playbook_runs WHERE playbook = ?").run(id);
    })();
  }

  /** Schedules that should have run by `now`: on, not finished, with a next run at or before it. */
  due(now: string): ScheduleRow[] {
    return this.list()
      .filter((s) => !s.paused && !s.done && s.nextRunAt !== null && s.nextRunAt <= now)
      .sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? "") || a.id.localeCompare(b.id));
  }

  /** The earliest next run of any active schedule, or undefined when none is waiting. */
  earliest(): string | undefined {
    const times = this.list()
      .filter((s) => !s.paused && !s.done && s.nextRunAt !== null)
      .map((s) => s.nextRunAt as string)
      .sort();
    return times[0];
  }
}
