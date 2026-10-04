import { type EvalReport, EvalReportSchema, type EvalSet } from "@majhi/shared";
import type Database from "better-sqlite3";

interface Row {
  id: number;
  slot: string;
  set_name: string;
  at: string;
  report: string;
}

/** Eval results (`decision_evals`): every run, kept, so the Hub shows the last one and a drift is visible. */
export class EvalStore {
  constructor(private readonly db: Database.Database) {}

  add(report: Omit<EvalReport, "id">): EvalReport {
    const info = this.db
      .prepare("INSERT INTO decision_evals (slot, set_name, at, report) VALUES (?, ?, ?, ?)")
      .run(report.slot, report.set, report.at, JSON.stringify(report));
    return { ...report, id: Number(info.lastInsertRowid) };
  }

  /** The newest run of a slot on a set. */
  latest(slot: string, set: EvalSet): EvalReport | undefined {
    const row = this.db
      .prepare("SELECT * FROM decision_evals WHERE slot = ? AND set_name = ? ORDER BY id DESC LIMIT 1")
      .get(slot, set) as Row | undefined;
    return row === undefined ? undefined : this.parse(row);
  }

  /** Newest first. */
  history(slot: string, limit = 20): EvalReport[] {
    const rows = this.db
      .prepare("SELECT * FROM decision_evals WHERE slot = ? ORDER BY id DESC LIMIT ?")
      .all(slot, limit) as Row[];
    return rows.flatMap((r) => this.parse(r) ?? []);
  }

  private parse(row: Row): EvalReport | undefined {
    let json: unknown;
    try {
      json = JSON.parse(row.report);
    } catch {
      return undefined;
    }
    const parsed = EvalReportSchema.safeParse(
      typeof json === "object" && json !== null ? { ...json, id: row.id } : json,
    );
    return parsed.success ? parsed.data : undefined;
  }
}
