import {
  type Finding,
  FindingSchema,
  type FindingSeverity,
  type FindingSource,
  type FindingStatus,
  type FindingTriage,
  FindingTriageSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { parseRows } from "../store/tolerant.ts";

/** The findings table in `majhi.db` (migration 125). */

interface Row {
  id: number;
  org: string;
  project: string | null;
  source: string;
  title: string;
  detail: string;
  evidence: string;
  severity: string;
  goal: string | null;
  playbook: string | null;
  channel: string | null;
  dedupe_key: string;
  status: string;
  task: string | null;
  decision: string | null;
  dismissed_reason: string | null;
  triage: string | null;
  by: string;
  seen: number;
  created_at: string;
  updated_at: string;
  last_seen: string;
}

function evidenceOf(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The stored triage, or undefined when it is missing or no longer fits the schema. */
function triageOf(raw: string | null): FindingTriage | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = FindingTriageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function toFinding(r: Row): Finding {
  const triage = triageOf(r.triage);
  return FindingSchema.parse({
    ...(triage === undefined ? {} : { triage }),
    id: r.id,
    org: r.org,
    ...(r.project === null ? {} : { project: r.project }),
    source: r.source,
    title: r.title,
    detail: r.detail,
    evidence: evidenceOf(r.evidence),
    severity: r.severity,
    ...(r.goal === null ? {} : { goal: r.goal }),
    ...(r.playbook === null ? {} : { playbook: r.playbook }),
    ...(r.channel === null ? {} : { channel: r.channel }),
    dedupeKey: r.dedupe_key,
    status: r.status,
    ...(r.task === null ? {} : { task: r.task }),
    ...(r.decision === null ? {} : { decision: r.decision }),
    ...(r.dismissed_reason === null ? {} : { dismissedReason: r.dismissed_reason }),
    by: r.by,
    seen: r.seen,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastSeen: r.last_seen,
  });
}

/** The findings of these rows. A row that does not parse (an unknown source, say) is skipped and logged once. */
const readFindings = (rows: readonly Row[]): Finding[] => parseRows("findings", rows, (r) => r.id, toFinding);

export interface NewFinding {
  org: string;
  project?: string | undefined;
  source: FindingSource;
  title: string;
  detail: string;
  evidence: string[];
  severity: FindingSeverity;
  goal?: string | undefined;
  playbook?: string | undefined;
  channel?: string | undefined;
  dedupeKey: string;
  by: string;
  at: string;
}

export interface FindingPatch {
  title?: string;
  detail?: string;
  evidence?: string[];
  severity?: FindingSeverity;
  status?: FindingStatus;
  /** `null` clears it. */
  task?: string | null;
  decision?: string | null;
  dismissedReason?: string | null;
  triage?: FindingTriage | null;
  lastSeen?: string;
  seen?: number;
  at: string;
}

export class FindingsRepo {
  constructor(private readonly db: Database.Database) {}

  get(id: number): Finding | undefined {
    const row = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : readFindings([row])[0];
  }

  byKey(org: string, key: string): Finding | undefined {
    const row = this.db.prepare("SELECT * FROM findings WHERE org = ? AND dedupe_key = ?").get(org, key) as
      | Row
      | undefined;
    return row === undefined ? undefined : readFindings([row])[0];
  }

  add(n: NewFinding): Finding {
    const info = this.db
      .prepare(
        `INSERT INTO findings (org, project, source, title, detail, evidence, severity, goal, playbook, channel,
           dedupe_key, status, by, seen, created_at, updated_at, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, 1, ?, ?, ?)`,
      )
      .run(
        n.org,
        n.project ?? null,
        n.source,
        n.title,
        n.detail,
        JSON.stringify(n.evidence),
        n.severity,
        n.goal ?? null,
        n.playbook ?? null,
        n.channel ?? null,
        n.dedupeKey,
        n.by,
        n.at,
        n.at,
        n.at,
      );
    const found = this.get(Number(info.lastInsertRowid));
    if (found === undefined) throw new Error("The finding was not written.");
    return found;
  }

  patch(id: number, p: FindingPatch): Finding {
    const sets: string[] = ["updated_at = ?"];
    const args: unknown[] = [p.at];
    const set = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      args.push(value);
    };
    if (p.title !== undefined) set("title", p.title);
    if (p.detail !== undefined) set("detail", p.detail);
    if (p.evidence !== undefined) set("evidence", JSON.stringify(p.evidence));
    if (p.severity !== undefined) set("severity", p.severity);
    if (p.status !== undefined) set("status", p.status);
    if (p.task !== undefined) set("task", p.task);
    if (p.decision !== undefined) set("decision", p.decision);
    if (p.dismissedReason !== undefined) set("dismissed_reason", p.dismissedReason);
    if (p.triage !== undefined) set("triage", p.triage === null ? null : JSON.stringify(p.triage));
    if (p.lastSeen !== undefined) set("last_seen", p.lastSeen);
    if (p.seen !== undefined) set("seen", p.seen);
    this.db.prepare(`UPDATE findings SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    const found = this.get(id);
    if (found === undefined) throw new Error(`Finding ${id} is gone.`);
    return found;
  }

  /** Newest first. */
  list(filter: {
    org?: string | undefined;
    project?: string | undefined;
    source?: string | undefined;
    statuses?: readonly FindingStatus[] | undefined;
    limit: number;
  }): Finding[] {
    const parts: string[] = [];
    const args: unknown[] = [];
    if (filter.org !== undefined) {
      parts.push("org = ?");
      args.push(filter.org);
    }
    if (filter.project !== undefined) {
      parts.push("project = ?");
      args.push(filter.project);
    }
    if (filter.source !== undefined) {
      parts.push("source = ?");
      args.push(filter.source);
    }
    if (filter.statuses !== undefined) {
      parts.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
      args.push(...filter.statuses);
    }
    const where = parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
    return readFindings(
      this.db
        .prepare(`SELECT * FROM findings ${where} ORDER BY last_seen DESC, id DESC LIMIT ?`)
        .all(...args, filter.limit) as Row[],
    );
  }

  /** How many findings a playbook filed in a workspace, and how many were taken up or dismissed. */
  statsByPlaybook(org: string, playbook: string): { total: number; accepted: number; dismissed: number } {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS total,
           COALESCE(SUM(status IN ('task', 'fixed', 'decision')), 0) AS accepted,
           COALESCE(SUM(status = 'dismissed'), 0) AS dismissed
         FROM findings WHERE org = ? AND playbook = ?`,
      )
      .get(org, playbook) as { total: number; accepted: number; dismissed: number };
  }

  /** Findings first seen or refreshed at or after `since` that a playbook filed. */
  countSince(org: string, playbook: string, since: string): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM findings WHERE org = ? AND playbook = ? AND last_seen >= ?")
        .get(org, playbook, since) as { n: number }
    ).n;
  }

  /** Findings linked to a task, to follow the task. */
  linked(): Finding[] {
    return readFindings(
      this.db
        .prepare("SELECT * FROM findings WHERE task IS NOT NULL AND status IN ('proposed', 'task')")
        .all() as Row[],
    );
  }
}
