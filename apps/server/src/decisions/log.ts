import {
  type DecisionCorrection,
  type DecisionOutcome,
  type DecisionRecord,
  DecisionRecordSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { redactText } from "../admin/policy.ts";

interface Row {
  id: string;
  at: string;
  use: string;
  task: string | null;
  agent: string | null;
  summary: string;
  provider: string;
  answers: string;
  estimated: number;
  duration_ms: number;
  detail: string | null;
  outcome: string | null;
  correction: string | null;
}

/** Every string in a value with detected secrets hidden. Keys are kept: they are option and field names. */
function hideSecrets<T>(value: T): T {
  if (typeof value === "string") return redactText(value) as T;
  if (Array.isArray(value)) return value.map(hideSecrets) as T;
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hideSecrets(v)])) as T;
  return value;
}

/**
 * Every decision, in SQLite (`decisions` table), kept for learning which answers to trust: the
 * request as the provider got it, every probability and gate, what majhi did with the answer, and
 * the owner's correction. The state is task and message text, so detected secrets are hidden
 * before anything is written.
 */
export class DecisionLog {
  constructor(private readonly db: Database.Database) {}

  add(record: DecisionRecord): void {
    const detail = {
      ...(record.request === undefined ? {} : { request: hideSecrets(record.request) }),
      ...(record.trimmed === undefined ? {} : { trimmed: record.trimmed }),
      ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
      ...(record.version === undefined ? {} : { version: record.version }),
    };
    this.db
      .prepare(
        "INSERT INTO decisions (id, at, use, task, agent, summary, provider, answers, estimated, duration_ms, detail, outcome, correction) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.at,
        record.use,
        record.task ?? null,
        record.agent ?? null,
        redactText(record.summary),
        record.provider,
        JSON.stringify(record.answers),
        record.estimated ? 1 : 0,
        record.durationMs,
        JSON.stringify(detail),
        record.outcome === undefined ? null : JSON.stringify(hideSecrets(record.outcome)),
        null,
      );
  }

  /** What majhi did with the answer. Replaces an earlier outcome. False when there is no such decision. */
  setOutcome(id: string, outcome: DecisionOutcome): boolean {
    const info = this.db
      .prepare("UPDATE decisions SET outcome = ? WHERE id = ?")
      .run(JSON.stringify(hideSecrets(outcome)), id);
    return info.changes > 0;
  }

  /** The owner's correction. Replaces an earlier one. False when there is no such decision. */
  correct(id: string, correction: DecisionCorrection): boolean {
    const info = this.db
      .prepare("UPDATE decisions SET correction = ? WHERE id = ?")
      .run(JSON.stringify(hideSecrets(correction)), id);
    return info.changes > 0;
  }

  /** How many decisions of a use one provider answered since `since`. */
  countSince(use: string, provider: string, since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM decisions WHERE use = ? AND provider = ? AND at >= ?")
      .get(use, provider, since) as { n: number };
    return row.n;
  }

  get(id: string): DecisionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  /** Newest first, `limit` from `offset`. Rows that no longer fit the schema are left out. */
  recent(limit: number, offset = 0): DecisionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM decisions ORDER BY at DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as Row[];
    return rows.flatMap((row) => {
      const record = toRecord(row);
      return record === undefined ? [] : [record];
    });
  }
}

function toRecord(row: Row): DecisionRecord | undefined {
  const detail = row.detail === null ? {} : safeJson(row.detail);
  const parsed = DecisionRecordSchema.safeParse({
    id: row.id,
    at: row.at,
    use: row.use,
    ...(row.task === null ? {} : { task: row.task }),
    ...(row.agent === null ? {} : { agent: row.agent }),
    summary: row.summary,
    provider: row.provider,
    answers: safeJson(row.answers),
    estimated: row.estimated === 1,
    durationMs: row.duration_ms,
    ...(typeof detail === "object" && detail !== null ? detail : {}),
    ...(row.outcome === null ? {} : { outcome: safeJson(row.outcome) }),
    ...(row.correction === null ? {} : { correction: safeJson(row.correction) }),
  });
  return parsed.success ? parsed.data : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
