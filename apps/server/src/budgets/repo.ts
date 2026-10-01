import type { BudgetAlert, BudgetScope, BudgetThreshold } from "@majhi/shared";
import type Database from "better-sqlite3";

/** The `budget_alerts` table: which thresholds fired for a budget in a week. */
export class BudgetAlertRepo {
  private readonly insertStmt: Database.Statement;
  private readonly deleteStmt: Database.Statement;
  private readonly listStmt: Database.Statement;
  private readonly resumedStmt: Database.Statement;
  private readonly setResumedStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.resumedStmt = db.prepare("SELECT at FROM budget_resumes WHERE task = ?");
    this.setResumedStmt = db.prepare(
      "INSERT INTO budget_resumes (task, at) VALUES (?, ?) ON CONFLICT (task) DO UPDATE SET at = excluded.at",
    );
    this.insertStmt = db.prepare(
      "INSERT OR IGNORE INTO budget_alerts (scope, id, week, threshold, at) VALUES (?, ?, ?, ?, ?)",
    );
    this.deleteStmt = db.prepare(
      "DELETE FROM budget_alerts WHERE scope = ? AND id = ? AND week = ? AND threshold = ?",
    );
    this.listStmt = db.prepare(
      "SELECT threshold, at FROM budget_alerts WHERE scope = ? AND id = ? AND week = ? ORDER BY threshold ASC",
    );
  }

  /** Thresholds fired for this budget in this week, lowest first. */
  fired(scope: BudgetScope, id: string, week: string): BudgetAlert[] {
    return this.listStmt.all(scope, id, week) as BudgetAlert[];
  }

  /** Records a threshold. False when it was already recorded. */
  add(scope: BudgetScope, id: string, week: string, threshold: BudgetThreshold, at: string): boolean {
    return this.insertStmt.run(scope, id, week, threshold, at).changes > 0;
  }

  remove(scope: BudgetScope, id: string, week: string, threshold: BudgetThreshold): void {
    this.deleteStmt.run(scope, id, week, threshold);
  }

  /** When the owner last resumed this task by hand out of a budget pause. */
  resumedAt(task: string): string | undefined {
    return (this.resumedStmt.get(task) as { at: string } | undefined)?.at;
  }

  setResumed(task: string, at: string): void {
    this.setResumedStmt.run(task, at);
  }
}
