import { PRIVATE } from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WeekRows } from "./report.ts";

const TimelineSchema = z.array(z.object({ kind: z.string(), at: z.string() }));

/** What the weekly report reads from `majhi.db`, and its once-a-week mark. Reads only; the mark is the one write. */
export class ReportRepo {
  constructor(private readonly db: Database.Database) {}

  /** Marks the week of a workspace as reported. False when it was marked already (a restart, a second sweep). */
  claim(week: string, org: string, at: string): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO weekly_reports (week, org, at) VALUES (?, ?, ?)")
        .run(week, org, at).changes > 0
    );
  }

  rows(org: string, from: string, to: string): WeekRows {
    const shipped = this.db
      .prepare(
        `SELECT t.id AS task, t.title AS title FROM tasks t
          WHERE t.kind != 'chat' AND COALESCE(t.org, ?) = ?
            AND (EXISTS (SELECT 1 FROM task_events e
                          WHERE e.task = t.id AND e.refused = 0 AND e.to_status = 'done'
                            AND coalesce(e.from_status, '') != 'done' AND e.at >= ? AND e.at < ?)
              OR EXISTS (SELECT 1 FROM task_repos r WHERE r.task = t.id AND r.landed_at >= ? AND r.landed_at < ?))
          ORDER BY t.id`,
      )
      .all(PRIVATE, org, from, to, from, to) as { task: string; title: string }[];
    const runs = this.db
      .prepare(
        `SELECT r.started_at AS startedAt, r.ended_at AS endedAt FROM runs r JOIN tasks t ON t.id = r.task
          WHERE COALESCE(t.org, ?) = ? AND r.ended_at IS NOT NULL AND r.ended_at >= ? AND r.ended_at < ?`,
      )
      .all(PRIVATE, org, from, to) as { startedAt: string; endedAt: string }[];
    const cost = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM turns WHERE COALESCE(org, ?) = ? AND at >= ? AND at < ?",
      )
      .get(PRIVATE, org, from, to) as { cost: number };
    const incidents = (
      this.db
        .prepare(
          `SELECT opened_at AS openedAt, resolved_at AS resolvedAt, timeline FROM ops_incidents
            WHERE org = ? AND opened_at < ? AND (resolved_at IS NULL OR resolved_at > ?)`,
        )
        .all(org, to, from) as { openedAt: string; resolvedAt: string | null; timeline: string }[]
    ).map((i) => {
      let timeline: z.infer<typeof TimelineSchema> = [];
      try {
        const parsed = TimelineSchema.safeParse(JSON.parse(i.timeline));
        if (parsed.success) timeline = parsed.data;
      } catch {
        timeline = [];
      }
      return {
        openedAt: i.openedAt,
        ...(i.resolvedAt === null ? {} : { resolvedAt: i.resolvedAt }),
        timeline,
      };
    });
    const monitored =
      this.db.prepare("SELECT 1 FROM ops_services WHERE org = ? LIMIT 1").get(org) !== undefined;
    return { shipped, runs, cost: cost.cost, incidents, monitored };
  }
}
