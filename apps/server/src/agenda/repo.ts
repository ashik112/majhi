import {
  AGENDA_BUDGET_DEFAULT,
  type Brief,
  type BriefFacts,
  BriefFactsSchema,
  MorningBriefSourceSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

interface BriefRow {
  day: string;
  at: string;
  source: string;
  lines: string;
  facts: string;
  dismissed_at: string | null;
}

const LinesSchema = z.array(z.string());

/** The brief per day and the owner's agenda settings, in `majhi.db`. */
export class AgendaRepo {
  constructor(private readonly db: Database.Database) {}

  /** The brief of a day. A row that no longer parses reads as none. */
  brief(day: string): Brief | undefined {
    const row = this.db.prepare("SELECT * FROM morning_briefs WHERE day = ?").get(day) as
      | BriefRow
      | undefined;
    if (row === undefined) return undefined;
    try {
      const source = MorningBriefSourceSchema.parse(row.source);
      const lines = LinesSchema.parse(JSON.parse(row.lines));
      const facts = BriefFactsSchema.parse(JSON.parse(row.facts));
      if (lines.length === 0) return undefined;
      return { day: row.day, at: row.at, lines, source, facts, dismissed: row.dismissed_at !== null };
    } catch {
      return undefined;
    }
  }

  hasBrief(day: string): boolean {
    return this.db.prepare("SELECT 1 FROM morning_briefs WHERE day = ?").get(day) !== undefined;
  }

  /** Stores the day's brief once. False when the day has one already: the primary key is the once-per-day rule. */
  addBrief(day: string, at: string, source: string, lines: readonly string[], facts: BriefFacts): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO morning_briefs (day, at, source, lines, facts) VALUES (?, ?, ?, ?, ?)",
        )
        .run(day, at, source, JSON.stringify(lines), JSON.stringify(facts)).changes > 0
    );
  }

  dismiss(day: string, at: string): void {
    this.db
      .prepare("UPDATE morning_briefs SET dismissed_at = COALESCE(dismissed_at, ?) WHERE day = ?")
      .run(at, day);
  }

  /** When the newest brief before this day was made, for the span "since the last brief". */
  lastBriefAt(before: string): string | undefined {
    const row = this.db
      .prepare("SELECT at FROM morning_briefs WHERE day < ? ORDER BY day DESC LIMIT 1")
      .get(before) as { at: string } | undefined;
    return row?.at;
  }

  budgetMinutes(): number {
    const row = this.db.prepare("SELECT value FROM agenda_settings WHERE key = 'review_minutes'").get() as
      | { value: string }
      | undefined;
    const n = Number(row?.value);
    return Number.isInteger(n) && n >= 5 && n <= 600 ? n : AGENDA_BUDGET_DEFAULT;
  }

  setBudgetMinutes(minutes: number): void {
    this.db
      .prepare(
        "INSERT INTO agenda_settings (key, value) VALUES ('review_minutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(minutes));
  }
}
