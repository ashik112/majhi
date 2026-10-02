import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  type CloneJob,
  type ClonePhase,
  ClonePhaseSchema,
  cloneTempPath,
  type MrHost,
  MrHostSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { isInside } from "./paths.ts";

/** Ended jobs are listed this long. */
export const LIST_ENDED_MS = 60 * 60_000;
/** Ended jobs are deleted from the table after this. */
const KEEP_ROWS_MS = 7 * 24 * 60 * 60_000;
export const RESTARTED = "majhi restarted before the clone finished. Clone it again.";

interface Row {
  id: string;
  org: string;
  kind: string;
  host: string;
  full_name: string;
  root: string;
  path: string;
  project: string;
  state: string;
  phase: string | null;
  percent: number | null;
  base: string | null;
  reason: string | null;
  created_folder: number;
  started_at: string;
  ended_at: string | null;
}

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function newCloneId(): string {
  let id = "cl_";
  for (const b of randomBytes(20)) id += ID_CHARS[b % ID_CHARS.length];
  return id;
}

export interface NewCloneJob {
  id: string;
  org: string;
  kind: MrHost;
  host: string;
  fullName: string;
  root: string;
  path: string;
  project: string;
  /** The target did not exist before this job, so majhi made it. */
  createdFolder: boolean;
}

function toJob(row: Row): CloneJob | undefined {
  const kind = MrHostSchema.safeParse(row.kind);
  if (!kind.success) return undefined;
  const base = {
    clone: row.id,
    org: row.org,
    kind: kind.data,
    host: row.host,
    fullName: row.full_name,
    path: row.path,
    project: row.project,
    startedAt: row.started_at,
  };
  switch (row.state) {
    case "queued":
      return { ...base, state: "queued" };
    case "cloning": {
      const phase = ClonePhaseSchema.safeParse(row.phase);
      return {
        ...base,
        state: "cloning",
        phase: phase.success ? phase.data : "connecting",
        ...(row.percent === null ? {} : { percent: row.percent }),
      };
    }
    case "registering":
      return { ...base, state: "registering" };
    case "done":
      return { ...base, state: "done", endedAt: row.ended_at ?? row.started_at, base: row.base ?? "" };
    case "failed":
      return {
        ...base,
        state: "failed",
        endedAt: row.ended_at ?? row.started_at,
        reason: row.reason ?? "The clone failed.",
      };
    default:
      return undefined;
  }
}

/**
 * Clone jobs in majhi.db (migration 115). States only move forward: queued, cloning, registering,
 * then done or failed. Ended rows never change again.
 */
export class CloneRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  insert(job: NewCloneJob): CloneJob {
    this.db
      .prepare(
        `INSERT INTO clone_jobs (id, org, kind, host, full_name, root, path, project, state, created_folder, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        job.id,
        job.org,
        job.kind,
        job.host,
        job.fullName,
        job.root,
        job.path,
        job.project,
        job.createdFolder ? 1 : 0,
        new Date(this.now()).toISOString(),
      );
    const made = this.get(job.id);
    if (made === undefined) throw new Error("clone job was not saved");
    return made;
  }

  get(id: string): CloneJob | undefined {
    const row = this.db.prepare("SELECT * FROM clone_jobs WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  /** Jobs still running, and jobs that ended within the hour, newest first. */
  list(): CloneJob[] {
    const since = new Date(this.now() - LIST_ENDED_MS).toISOString();
    const rows = this.db
      .prepare(
        "SELECT * FROM clone_jobs WHERE ended_at IS NULL OR ended_at >= ? ORDER BY started_at DESC, id DESC",
      )
      .all(since) as Row[];
    return rows.flatMap((r) => toJob(r) ?? []);
  }

  /** Running jobs, for refusing a second clone of the same repo or into the same folder. */
  running(): CloneJob[] {
    const rows = this.db.prepare("SELECT * FROM clone_jobs WHERE ended_at IS NULL").all() as Row[];
    return rows.flatMap((r) => toJob(r) ?? []);
  }

  progress(id: string, phase: ClonePhase, percent: number | undefined): void {
    this.db
      .prepare(
        "UPDATE clone_jobs SET state = 'cloning', phase = ?, percent = ? WHERE id = ? AND state IN ('queued', 'cloning')",
      )
      .run(phase, percent ?? null, id);
  }

  registering(id: string): void {
    this.db
      .prepare("UPDATE clone_jobs SET state = 'registering' WHERE id = ? AND state IN ('queued', 'cloning')")
      .run(id);
  }

  done(id: string, base: string): void {
    this.db
      .prepare(
        "UPDATE clone_jobs SET state = 'done', base = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
      )
      .run(base, new Date(this.now()).toISOString(), id);
  }

  /** `reason` is a plain sentence: never git's raw output, a URL with credentials or a token. */
  failed(id: string, reason: string): void {
    this.db
      .prepare(
        "UPDATE clone_jobs SET state = 'failed', reason = ?, ended_at = ? WHERE id = ? AND ended_at IS NULL",
      )
      .run(reason, new Date(this.now()).toISOString(), id);
  }

  /**
   * After a restart: every job that had not ended is marked failed ("majhi restarted"), and the
   * folders it may have left are removed: its temporary sibling always (majhi made it), and the
   * target only when majhi made it in that job, and only inside the job's root. A job whose project
   * got registered before the restart is marked done instead. Old rows are dropped.
   */
  async recover(registered: (path: string) => string | undefined): Promise<number> {
    const rows = this.db.prepare("SELECT * FROM clone_jobs WHERE ended_at IS NULL").all() as Row[];
    for (const row of rows) {
      if (registered(row.path) !== undefined) {
        this.done(row.id, row.base ?? "");
        continue;
      }
      this.failed(row.id, RESTARTED);
      const temp = cloneTempPath(row.path, row.id);
      if (isInside(row.root, temp) && temp !== row.root) await rm(temp, { recursive: true, force: true });
      if (row.created_folder === 1 && isInside(row.root, row.path) && row.path !== row.root) {
        await rm(row.path, { recursive: true, force: true });
      }
    }
    this.db
      .prepare("DELETE FROM clone_jobs WHERE ended_at IS NOT NULL AND ended_at < ?")
      .run(new Date(this.now() - KEEP_ROWS_MS).toISOString());
    return rows.length;
  }
}
