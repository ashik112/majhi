import type { AuditBy } from "@majhi/shared";
import type { Store } from "./store/index.ts";

/** The audit row's `agent` and `by` for whoever triggered something: `owner`, `majhi`, or an agent id. */
export function auditActor(who: string): { agent: string; by: AuditBy } {
  return { agent: who, by: who === "owner" ? "owner" : who === "majhi" ? "majhi" : "agent" };
}

/** An error or branch line for the audit `detail` column: one line, short. */
export function auditDetail(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 400 ? `${line.slice(0, 399)}…` : line;
}

const SHIP_LABELS = {
  push: "Push of",
  mr: "Merge request for",
  merge: "Merge of",
  "merge+push": "Push after merge of",
} as const;

/**
 * One audit row for what happened to one repo of a task: a push, a merge request, a merge, or the
 * push that follows a merge. It is written by the service that does the work, so the review card,
 * the command and the agent tool all leave the same row. `detail` is the target branch, the MR
 * link or the error.
 */
export function logShip(
  store: Store,
  row: {
    task: string;
    kind: keyof typeof SHIP_LABELS;
    /** `owner`, `majhi` or an agent id. */
    who: string;
    ok: boolean;
    project: string;
    detail: string;
    at: Date;
  },
): void {
  store.permissions.log({
    task: row.task,
    ...auditActor(row.who),
    kind: row.kind,
    title: `${SHIP_LABELS[row.kind]} ${row.project}`,
    decision: row.ok ? "done" : "failed",
    at: row.at.toISOString(),
    detail: auditDetail(row.detail),
  });
}
