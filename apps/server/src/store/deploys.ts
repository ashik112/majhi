import { type DeployRecord, DeployRecordSchema, type DeployState, deployMayMove } from "@majhi/shared";
import type Database from "better-sqlite3";

/**
 * The deploy records (docs/design/ship-without-me.md, section 3): one row per target and commit.
 * `UNIQUE (project, env, commit_sha)` is what makes a deploy happen once: a second request for the
 * same pair finds the row. A move between states is a compare-and-set against the state the caller
 * saw, so two callers racing to start or finish one deploy cannot both win.
 */

interface Row {
  id: number;
  org: string;
  project: string;
  env: string;
  commit_sha: string;
  previous: string | null;
  state: string;
  task: string | null;
  by: string;
  run: string | null;
  check_result: string | null;
  reason: string | null;
  rollback: string | null;
  incident: string | null;
  unchecked: number;
  attempt: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface NewDeploy {
  org: string;
  project: string;
  env: string;
  commit: string;
  previous?: string | undefined;
  state: Extract<DeployState, "held" | "queued">;
  task?: string | undefined;
  by: DeployRecord["by"];
  unchecked?: boolean | undefined;
  reason?: string | undefined;
  at: string;
}

/** What a move may set besides the state. `undefined` leaves a column alone. */
export interface DeployPatch {
  run?: DeployRecord["run"] | undefined;
  check?: DeployRecord["check"] | undefined;
  reason?: string | null | undefined;
  rollback?: DeployRecord["rollback"] | undefined;
  incident?: string | undefined;
  previous?: string | undefined;
  by?: DeployRecord["by"] | undefined;
  task?: string | undefined;
  unchecked?: boolean | undefined;
  finished?: boolean | undefined;
}

export class DeployRepo {
  constructor(private readonly sqlite: Database.Database) {}

  /** Adds the row for a target and commit. Returns undefined when the pair already has one. */
  create(input: NewDeploy): DeployRecord | undefined {
    const done = this.sqlite
      .prepare(
        `INSERT INTO deploys (org, project, env, commit_sha, previous, state, task, by, reason, unchecked, attempt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (project, env, commit_sha) DO NOTHING`,
      )
      .run(
        input.org,
        input.project,
        input.env,
        input.commit,
        input.previous ?? null,
        input.state,
        input.task ?? null,
        input.by,
        input.reason ?? null,
        input.unchecked === true ? 1 : 0,
        input.at,
        input.at,
      );
    if (done.changes === 0) return undefined;
    return this.get(Number(done.lastInsertRowid));
  }

  get(id: number): DeployRecord | undefined {
    const row = this.sqlite.prepare("SELECT * FROM deploys WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : record(row);
  }

  find(project: string, env: string, commit: string): DeployRecord | undefined {
    const row = this.sqlite
      .prepare("SELECT * FROM deploys WHERE project = ? AND env = ? AND commit_sha = ?")
      .get(project, env, commit) as Row | undefined;
    return row === undefined ? undefined : record(row);
  }

  /** A project's deploys, newest first. */
  ofProject(project: string, limit: number): DeployRecord[] {
    return this.rows("SELECT * FROM deploys WHERE project = ? ORDER BY id DESC LIMIT ?", project, limit);
  }

  /** The deploys one task started, oldest first. */
  ofTask(task: string): DeployRecord[] {
    return this.rows("SELECT * FROM deploys WHERE task = ? ORDER BY id", task);
  }

  /** Every deploy a task started, by task: one read for a whole board. */
  ofTasks(): Map<string, DeployRecord[]> {
    const out = new Map<string, DeployRecord[]>();
    for (const r of this.rows("SELECT * FROM deploys WHERE task IS NOT NULL ORDER BY id")) {
      if (r.task === undefined) continue;
      const list = out.get(r.task);
      if (list === undefined) out.set(r.task, [r]);
      else list.push(r);
    }
    return out;
  }

  /** Deploys that were running when majhi stopped: they are followed again at start. */
  active(): DeployRecord[] {
    return this.rows("SELECT * FROM deploys WHERE state IN ('queued', 'running', 'verifying') ORDER BY id");
  }

  /** The commit a target runs now: the newest deploy of it that is live. */
  latestLive(project: string, env: string): DeployRecord | undefined {
    return this.rows(
      "SELECT * FROM deploys WHERE project = ? AND env = ? AND state = 'live' ORDER BY id DESC LIMIT 1",
      project,
      env,
    )[0];
  }

  /** The commits every environment of a project is live at now, newest per environment. */
  liveOf(project: string): DeployRecord[] {
    return this.rows(
      `SELECT d.* FROM deploys d
       WHERE d.project = ? AND d.state = 'live'
         AND d.id = (SELECT MAX(id) FROM deploys WHERE project = d.project AND env = d.env AND state = 'live')
       ORDER BY d.env`,
      project,
    );
  }

  /**
   * Moves a record from the state the caller read to the next one, and sets what the move carries.
   * Returns the new record, or undefined when the record was not in `from` any more (someone else
   * moved it first). A move the table does not allow throws: it is a bug, not a race.
   */
  move(
    id: number,
    from: DeployState,
    to: DeployState,
    at: string,
    patch: DeployPatch = {},
  ): DeployRecord | undefined {
    if (!deployMayMove(from, to)) throw new Error(`A deploy cannot go from ${from} to ${to}.`);
    const sets = ["state = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, at];
    const set = (column: string, value: string | number | null) => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.run !== undefined) set("run", JSON.stringify(patch.run));
    if (patch.check !== undefined) set("check_result", JSON.stringify(patch.check));
    if (patch.reason !== undefined) set("reason", patch.reason);
    if (patch.rollback !== undefined) set("rollback", JSON.stringify(patch.rollback));
    if (patch.incident !== undefined) set("incident", patch.incident);
    if (patch.previous !== undefined) set("previous", patch.previous);
    if (patch.by !== undefined) set("by", patch.by);
    if (patch.task !== undefined) set("task", patch.task);
    if (patch.unchecked !== undefined) set("unchecked", patch.unchecked ? 1 : 0);
    if (patch.finished === true) set("finished_at", at);
    // A retry starts a new attempt from a clean record: what the last one found is not this one's.
    if ((from === "failed" || from === "rolled-back") && to === "queued") {
      sets.push("attempt = attempt + 1", "finished_at = NULL");
      if (patch.reason === undefined) sets.push("reason = NULL");
      if (patch.run === undefined) sets.push("run = NULL");
      if (patch.check === undefined) sets.push("check_result = NULL");
      if (patch.rollback === undefined) sets.push("rollback = NULL");
      if (patch.incident === undefined) sets.push("incident = NULL");
    }
    const done = this.sqlite
      .prepare(`UPDATE deploys SET ${sets.join(", ")} WHERE id = ? AND state = ?`)
      .run(...values, id, from);
    return done.changes === 0 ? undefined : this.get(id);
  }

  /** Sets what a record carries without moving it (the run link, the incident). */
  note(id: number, at: string, patch: Pick<DeployPatch, "run" | "incident" | "reason">): void {
    const sets = ["updated_at = ?"];
    const values: (string | null)[] = [at];
    if (patch.run !== undefined) {
      sets.push("run = ?");
      values.push(JSON.stringify(patch.run));
    }
    if (patch.incident !== undefined) {
      sets.push("incident = ?");
      values.push(patch.incident);
    }
    if (patch.reason !== undefined) {
      sets.push("reason = ?");
      values.push(patch.reason);
    }
    this.sqlite.prepare(`UPDATE deploys SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  private rows(sql: string, ...args: (string | number)[]): DeployRecord[] {
    const out: DeployRecord[] = [];
    for (const row of this.sqlite.prepare(sql).all(...args) as Row[]) {
      const parsed = record(row);
      if (parsed !== undefined) out.push(parsed);
    }
    return out;
  }
}

function json(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A row that no longer parses reads as absent. */
function record(row: Row): DeployRecord | undefined {
  const parsed = DeployRecordSchema.safeParse({
    id: row.id,
    org: row.org,
    project: row.project,
    env: row.env,
    commit: row.commit_sha,
    ...(row.previous === null ? {} : { previous: row.previous }),
    state: row.state,
    ...(row.task === null ? {} : { task: row.task }),
    by: row.by,
    run: json(row.run),
    check: json(row.check_result),
    ...(row.reason === null ? {} : { reason: row.reason }),
    rollback: json(row.rollback),
    ...(row.incident === null ? {} : { incident: row.incident }),
    ...(row.unchecked === 1 ? { unchecked: true } : {}),
    attempt: row.attempt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  });
  return parsed.success ? parsed.data : undefined;
}
