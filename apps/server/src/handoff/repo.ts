import {
  type HandoffHistoryItem,
  type HandoffResult,
  HandoffResultSchema,
  type HandoffReview,
  HandoffReviewSchema,
  type HandoffStep,
  HandoffStepSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

/** The tables of migration 140: the costly part of a check by head, its history, and the strikes. */

export interface DeepRow {
  task: string;
  head: string;
  at: string;
  ms: number;
  steps: HandoffStep[];
  review: HandoffReview;
}

interface RawDeep {
  task: string;
  head: string;
  at: string;
  ms: number;
  steps: string;
  review: string;
}

const StepsSchema = z.array(HandoffStepSchema);

export class HandoffRepo {
  constructor(private readonly db: Database.Database) {}

  deep(task: string, head: string): DeepRow | undefined {
    const row = this.db.prepare("SELECT * FROM handoff_deep WHERE task = ? AND head = ?").get(task, head) as
      | RawDeep
      | undefined;
    if (row === undefined) return undefined;
    // A row a newer build cannot read is a miss: the check runs again.
    try {
      const steps = StepsSchema.safeParse(JSON.parse(row.steps));
      const review = HandoffReviewSchema.safeParse(JSON.parse(row.review));
      if (!steps.success || !review.success) return undefined;
      return { task, head, at: row.at, ms: row.ms, steps: steps.data, review: review.data };
    } catch {
      return undefined;
    }
  }

  putDeep(row: DeepRow): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO handoff_deep (task, head, at, ms, steps, review) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(row.task, row.head, row.at, row.ms, JSON.stringify(row.steps), JSON.stringify(row.review));
  }

  dropDeep(task: string, head: string): void {
    this.db.prepare("DELETE FROM handoff_deep WHERE task = ? AND head = ?").run(task, head);
  }

  history(task: string, limit = 10): HandoffHistoryItem[] {
    const rows = this.db
      .prepare(
        "SELECT head, at, verdict, failures, action FROM handoff_history WHERE task = ? ORDER BY id DESC LIMIT ?",
      )
      .all(task, limit) as { head: string; at: string; verdict: string; failures: string; action: string }[];
    return rows.map((r) => ({
      head: r.head,
      at: r.at,
      verdict: r.verdict === "green" ? "green" : "red",
      failures: parseList(r.failures),
      action: r.action === "told" || r.action === "escalated" ? r.action : "none",
    }));
  }

  /** The history row of this head, if the head was judged already. */
  historyOf(task: string, head: string): HandoffHistoryItem | undefined {
    return this.history(task, 200).find((h) => h.head === head);
  }

  /** Records a head's verdict once. A second call for the same head keeps the first. */
  addHistory(task: string, item: HandoffHistoryItem, result: HandoffResult): boolean {
    const r = this.db
      .prepare(
        "INSERT OR IGNORE INTO handoff_history (task, head, at, verdict, failures, action, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        task,
        item.head,
        item.at,
        item.verdict,
        JSON.stringify(item.failures),
        item.action,
        JSON.stringify(result),
      );
    return r.changes > 0;
  }

  /** The whole result judged for this head, when one was kept and still reads. */
  resultOf(task: string, head: string): HandoffResult | undefined {
    const row = this.db
      .prepare("SELECT result FROM handoff_history WHERE task = ? AND head = ?")
      .get(task, head) as { result: string } | undefined;
    if (row === undefined || row.result === "") return undefined;
    try {
      const parsed = HandoffResultSchema.safeParse(JSON.parse(row.result));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  setAction(task: string, head: string, action: HandoffHistoryItem["action"]): void {
    this.db
      .prepare("UPDATE handoff_history SET action = ? WHERE task = ? AND head = ?")
      .run(action, task, head);
  }

  /** A forced check of a head replaces its verdict. */
  replaceHistory(task: string, item: HandoffHistoryItem, result: HandoffResult): void {
    this.db
      .prepare(
        "UPDATE handoff_history SET at = ?, verdict = ?, failures = ?, result = ? WHERE task = ? AND head = ?",
      )
      .run(item.at, item.verdict, JSON.stringify(item.failures), JSON.stringify(result), task, item.head);
  }

  state(task: string): { strikes: number; escalated: boolean } {
    const row = this.db.prepare("SELECT strikes, escalated FROM handoff_state WHERE task = ?").get(task) as
      | { strikes: number; escalated: number }
      | undefined;
    return { strikes: row?.strikes ?? 0, escalated: (row?.escalated ?? 0) === 1 };
  }

  setState(task: string, strikes: number, escalated: boolean): void {
    this.db
      .prepare(
        "INSERT INTO handoff_state (task, strikes, escalated) VALUES (?, ?, ?) ON CONFLICT(task) DO UPDATE SET strikes = excluded.strikes, escalated = excluded.escalated",
      )
      .run(task, strikes, escalated ? 1 : 0);
  }

  forget(task: string): void {
    for (const table of ["handoff_deep", "handoff_history", "handoff_state"]) {
      this.db.prepare(`DELETE FROM ${table} WHERE task = ?`).run(task);
    }
  }
}

function parseList(text: string): string[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}
