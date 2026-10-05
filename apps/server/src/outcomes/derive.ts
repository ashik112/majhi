import { type CaptainChore, type OutcomeResult, outboundKey, PRIVATE, TRIAGE_DISMISS } from "@majhi/shared";
import type Database from "better-sqlite3";
import type { Derived } from "./repo.ts";

/**
 * What the captain made and how it turned out, read from the tables that already hold the signals
 * (SPEC 5.18, Outcomes): the captain's log and its undo, the autonomous tasks it started, the outbound
 * drafts the owner decided, the findings the owner took or dismissed, and the owner's "Wrong?" marks on
 * Laya's decisions. Reading is pure and repeatable: each pass computes the judgment from what is there
 * now, so a signal that arrives an hour or a week later changes the outcome it belongs to. Nothing here
 * writes, and a deleted task leaves the action it came from standing, because the log keeps its own copy.
 */

/** How long an output waits for a taking-back before it counts as kept. */
export const KEEP_AFTER_MS = 6 * 3_600_000;
/** How far back a pass looks. Older outputs were judged by then. */
export const LOOKBACK_MS = 60 * 24 * 3_600_000;
/** A task the captain started, quiet this long, counts as kept. */
const START_KEEP_AFTER_MS = 7 * 24 * 3_600_000;

/** Which authority row a chore acts under. */
export const CHORE_ROW: Record<CaptainChore, string> = {
  ship: "merge",
  cards: "approvals",
  questions: "questions",
  memory: "upkeep",
  projects: "upkeep",
  triage: "upkeep",
  cleanup: "upkeep",
  followups: "upkeep",
  discover: "upkeep",
  tidy: "upkeep",
  health: "upkeep",
  checklist: "upkeep",
  map: "upkeep",
};

export interface DeriveOptions {
  now: Date;
  keepAfterMs?: number;
  /** The playbook that carries a chore (the catalog knows). */
  playbookOfChore?: (chore: CaptainChore) => string | undefined;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** The captain's own log: what it did, and whether the owner took it back. */
function fromActions(db: Database.Database, since: string, o: DeriveOptions): Derived[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.org, a.chore, a.key, a.at, a.task, a.undone_at, a.decision,
              EXISTS (SELECT 1 FROM decision_labels l WHERE l.decision_id = a.decision AND l.source = 'owner') AS marked
         FROM captain_actions a WHERE a.outcome = 'done' AND a.at >= ?`,
    )
    .all(since) as {
    id: number;
    org: string;
    chore: string;
    key: string;
    at: string;
    task: string | null;
    undone_at: string | null;
    decision: string | null;
    marked: number;
  }[];
  const keepAfter = o.keepAfterMs ?? KEEP_AFTER_MS;
  const out: Derived[] = [];
  for (const r of rows) {
    const chore = r.chore as CaptainChore;
    const playbook = o.playbookOfChore?.(chore);
    const row = r.key.startsWith("own:") ? "own" : (CHORE_ROW[chore] ?? "upkeep");
    let result: OutcomeResult | undefined;
    let settledAt: string | undefined;
    if (r.undone_at !== null) {
      result = chore === "ship" ? "merged-reverted" : "undone";
      settledAt = r.undone_at;
    } else if (r.marked === 1) {
      result = "overruled";
    } else if (o.now.getTime() - Date.parse(r.at) >= keepAfter) {
      result = "kept";
      settledAt = iso(Date.parse(r.at) + keepAfter);
    }
    out.push({
      subject: `action:${r.id}`,
      kind: "action",
      org: r.org,
      key: row,
      ...(playbook === undefined ? {} : { playbook }),
      action: r.id,
      ...(r.task === null ? {} : { task: r.task }),
      at: r.at,
      ...(result === undefined ? {} : { result }),
      ...(settledAt === undefined ? {} : { settledAt }),
    });
  }
  return out;
}

const STARTED = /^(Started|Created|Split out) [A-Z][A-Z0-9]*-\d+: /;
const FAILED = /because the agent hit an error|because the agent was going in circles|because it is blocked/;

/** Tasks the captain started or created: they fail, finish, or are left to run. */
function fromStarts(db: Database.Database, since: string, o: DeriveOptions): Derived[] {
  const events = db
    .prepare(
      `SELECT seq, at, text, task, org, status FROM autonomy_events
        WHERE kind = 'task' AND task IS NOT NULL AND at >= ? ORDER BY seq`,
    )
    .all(since) as {
    seq: number;
    at: string;
    text: string;
    task: string;
    org: string | null;
    status: string | null;
  }[];
  const firsts = new Map<string, { at: string; org: string | null }>();
  const failed = new Map<string, string>();
  const done = new Map<string, string>();
  for (const e of events) {
    if (STARTED.test(e.text) && !firsts.has(e.task)) firsts.set(e.task, { at: e.at, org: e.org });
    if (e.status === "paused" && FAILED.test(e.text) && !failed.has(e.task)) failed.set(e.task, e.at);
    if (e.status === "done" && !done.has(e.task)) done.set(e.task, e.at);
  }
  const out: Derived[] = [];
  for (const [task, first] of firsts) {
    const row = db.prepare("SELECT org FROM tasks WHERE id = ?").get(task) as
      | { org: string | null }
      | undefined;
    const org = first.org ?? row?.org ?? PRIVATE;
    let result: OutcomeResult | undefined;
    let settledAt: string | undefined;
    const failedAt = failed.get(task);
    const doneAt = done.get(task);
    if (failedAt !== undefined && failedAt >= first.at) {
      result = "task-failed";
      settledAt = failedAt;
    } else if (doneAt !== undefined) {
      result = "kept";
      settledAt = doneAt;
    } else if (row === undefined) {
      // Deleted before it finished: nothing to judge it on.
      result = "void";
    } else if (o.now.getTime() - Date.parse(first.at) >= START_KEEP_AFTER_MS) {
      result = "kept";
    }
    out.push({
      subject: `start:${task}`,
      kind: "start",
      org,
      key: "start",
      task,
      at: first.at,
      ...(result === undefined ? {} : { result }),
      ...(settledAt === undefined ? {} : { settledAt }),
    });
  }
  return out;
}

/** Drafts for the outbound gate: the owner approves or discards them; Auto sends are judged by time. */
function fromDrafts(db: Database.Database, since: string, o: DeriveOptions): Derived[] {
  const rows = db
    .prepare(
      `SELECT id, org, channel, playbook, status, mode, created_at, decided_at, by FROM outbound_drafts WHERE created_at >= ?`,
    )
    .all(since) as {
    id: number;
    org: string;
    channel: string;
    playbook: string | null;
    status: string;
    mode: string;
    created_at: string;
    decided_at: string | null;
    by: string;
  }[];
  const keepAfter = o.keepAfterMs ?? KEEP_AFTER_MS;
  const out: Derived[] = [];
  for (const r of rows) {
    let result: OutcomeResult | undefined;
    let settledAt: string | undefined;
    if (r.status === "discarded") {
      result = "rejected";
      settledAt = r.decided_at ?? undefined;
    } else if (r.status === "approved" || r.status === "failed" || r.status === "sent") {
      result = r.mode === "auto" ? undefined : "approved";
      if (result === undefined && o.now.getTime() - Date.parse(r.decided_at ?? r.created_at) >= keepAfter) {
        result = "kept";
      }
      settledAt = r.decided_at ?? undefined;
    }
    out.push({
      subject: `draft:${r.id}`,
      kind: "draft",
      org: r.org,
      key: outboundKey(r.channel),
      ...(r.playbook === null ? {} : { playbook: r.playbook }),
      at: r.created_at,
      ...(result === undefined ? {} : { result }),
      ...(settledAt === undefined ? {} : { settledAt }),
    });
  }
  return out;
}

/** The reason majhi gives a finding it folded into a grouped one (sensors, migrations 136 and 137). */
export const FOLDED = "Folded into";

/** Findings the owner took (a task, a decision, fixed) or dismissed. */
function fromFindings(db: Database.Database, since: string): Derived[] {
  const rows = db
    .prepare(
      "SELECT id, org, playbook, status, dismissed_reason, task, created_at, updated_at FROM findings WHERE created_at >= ?",
    )
    .all(since) as {
    id: number;
    org: string;
    playbook: string | null;
    status: string;
    dismissed_reason: string | null;
    task: string | null;
    created_at: string;
    updated_at: string;
  }[];
  return rows.map((r) => {
    const result: OutcomeResult | undefined =
      r.status === "dismissed" &&
      ((r.dismissed_reason ?? "").startsWith(FOLDED) || (r.dismissed_reason ?? "").startsWith(TRIAGE_DISMISS))
        ? // majhi folded it into a grouped finding, or Laya's triage dismissed it: nobody judged it, so it counts for nothing.
          "void"
        : r.status === "dismissed"
          ? "dismissed"
          : r.status === "task" || r.status === "decision" || r.status === "fixed"
            ? "accepted"
            : undefined;
    return {
      subject: `finding:${r.id}`,
      kind: "finding" as const,
      org: r.org,
      ...(r.playbook === null ? {} : { playbook: r.playbook }),
      ...(r.task === null ? {} : { task: r.task }),
      at: r.created_at,
      ...(result === undefined ? {} : { result, settledAt: r.updated_at }),
    };
  });
}

/** Every output of the last two months with the judgment it has now. */
export function deriveAll(db: Database.Database, o: DeriveOptions): Derived[] {
  const since = iso(o.now.getTime() - LOOKBACK_MS);
  return [
    ...fromActions(db, since, o),
    ...fromStarts(db, since, o),
    ...fromDrafts(db, since, o),
    ...fromFindings(db, since),
  ];
}
