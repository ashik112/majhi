import { type DecisionRecord, DecisionRecordSchema } from "@majhi/shared";
import type Database from "better-sqlite3";

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
}

/** Every decision, in SQLite (`decisions` table). */
export class DecisionLog {
  constructor(private readonly db: Database.Database) {}

  add(record: DecisionRecord): void {
    this.db
      .prepare(
        "INSERT INTO decisions (id, at, use, task, agent, summary, provider, answers, estimated, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.at,
        record.use,
        record.task ?? null,
        record.agent ?? null,
        record.summary,
        record.provider,
        JSON.stringify(record.answers),
        record.estimated ? 1 : 0,
        record.durationMs,
      );
  }

  /** Newest first. Rows that no longer fit the schema are left out. */
  recent(limit: number): DecisionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM decisions ORDER BY at DESC, rowid DESC LIMIT ?")
      .all(limit) as Row[];
    const out: DecisionRecord[] = [];
    for (const row of rows) {
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
      });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
