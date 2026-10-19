import type { AuditRow } from "../store/runs.ts";

/**
 * Sandbox actions never ask, and they are logged so the day's work can be read back (step 3 shows them in
 * Done today). One row per kind of action per task per minute, not one per command: a test run that makes
 * forty tool calls leaves one line. The row goes to the audit log, the one place permission decisions live.
 */
export class SandboxLog {
  /** `task|kind` to the minute (since the epoch) of the last row written. */
  private readonly last = new Map<string, number>();

  constructor(
    private readonly write: (row: AuditRow) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Writes the row unless one of the same task and kind was written in this minute. Returns whether it wrote. */
  note(row: Omit<AuditRow, "decision" | "by" | "at">): boolean {
    const at = this.now();
    const minute = Math.floor(at.getTime() / 60_000);
    const key = `${row.task}|${row.kind}`;
    if (this.last.get(key) === minute) return false;
    this.last.set(key, minute);
    if (this.last.size > 2_000) this.forgetOld(minute);
    this.write({ ...row, decision: "allow", by: "rule", at: at.toISOString() });
    return true;
  }

  private forgetOld(minute: number): void {
    for (const [key, seen] of this.last) if (seen < minute) this.last.delete(key);
  }
}
