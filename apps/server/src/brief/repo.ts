import { type Brief, type BriefFacts, BriefFactsSchema, MorningBriefSourceSchema } from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

interface BriefRow {
  day: string;
  org: string;
  at: string;
  source: string;
  lines: string;
  facts: string;
  quiet: number;
}

const LinesSchema = z.array(z.string());

/** The brief per workspace and day, and the once-a-day mark of the combined push, in `majhi.db`. */
export class BriefRepo {
  constructor(private readonly db: Database.Database) {}

  /** A row that no longer parses reads as none. */
  private read(row: BriefRow): Brief | undefined {
    try {
      const lines = LinesSchema.parse(JSON.parse(row.lines));
      if (lines.length === 0) return undefined;
      return {
        org: row.org,
        day: row.day,
        at: row.at,
        lines,
        source: MorningBriefSourceSchema.parse(row.source),
        facts: BriefFactsSchema.parse(JSON.parse(row.facts)),
        quiet: row.quiet === 1,
      };
    } catch {
      return undefined;
    }
  }

  /** Whether the day has briefs: the first brief of a day is made for every workspace at once. */
  hasDay(day: string): boolean {
    return this.db.prepare("SELECT 1 FROM workspace_briefs WHERE day = ? LIMIT 1").get(day) !== undefined;
  }

  /** The workspaces that have a brief on a day. */
  orgsOf(day: string): Set<string> {
    const rows = this.db.prepare("SELECT org FROM workspace_briefs WHERE day = ?").all(day) as {
      org: string;
    }[];
    return new Set(rows.map((r) => r.org));
  }

  /** Stores one workspace's brief once. False when it has one already: the primary key is the once-per-day rule. */
  add(brief: Brief): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO workspace_briefs (day, org, at, source, lines, facts, quiet) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          brief.day,
          brief.org,
          brief.at,
          brief.source,
          JSON.stringify(brief.lines),
          JSON.stringify(brief.facts satisfies BriefFacts),
          brief.quiet ? 1 : 0,
        ).changes > 0
    );
  }

  /** Briefs worth reading, newest day first. `org` keeps one workspace's. */
  list(org: string | undefined, limit: number): Brief[] {
    const rows = (
      org === undefined
        ? this.db
            .prepare("SELECT * FROM workspace_briefs WHERE quiet = 0 ORDER BY day DESC, org ASC LIMIT ?")
            .all(limit)
        : this.db
            .prepare("SELECT * FROM workspace_briefs WHERE quiet = 0 AND org = ? ORDER BY day DESC LIMIT ?")
            .all(org, limit)
    ) as BriefRow[];
    return rows.flatMap((r) => {
      const brief = this.read(r);
      return brief === undefined ? [] : [brief];
    });
  }

  /** When the newest brief before this day was made, for the span "since the last brief". */
  lastBriefAt(before: string): string | undefined {
    const row = this.db
      .prepare("SELECT MAX(at) AS at FROM workspace_briefs WHERE day < ?")
      .get(before) as { at: string | null };
    return row.at ?? undefined;
  }

  /** Marks the morning's push as sent. False when it was marked already (a second tab, a restart). */
  claimPush(day: string, at: string): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO brief_pushes (day, at) VALUES (?, ?)").run(day, at).changes > 0;
  }
}
