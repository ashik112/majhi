import { type TrackerLink, TrackerStageSchema, TrackerTypeSchema } from "@majhi/shared";
import type Database from "better-sqlite3";
import { z } from "zod";

interface Row {
  task: string;
  org: string | null;
  type: string;
  key: string;
  url: string;
  title: string;
  origin: string;
  status: string;
  stage: string | null;
  mrs: string;
  synced_at: string;
  error: string | null;
}

const MrsSchema = z.array(z.string());

const SELECT = `SELECT l.*, t.org AS org FROM tracker_links l JOIN tasks t ON t.id = l.task`;

function toLink(row: Row): TrackerLink {
  let mrs: string[] = [];
  try {
    mrs = MrsSchema.parse(JSON.parse(row.mrs));
  } catch {
    // A bad value only means the MR links are written again.
  }
  const stage = TrackerStageSchema.safeParse(row.stage);
  return {
    task: row.task,
    org: row.org ?? "",
    type: TrackerTypeSchema.catch("jira").parse(row.type),
    key: row.key,
    url: row.url,
    title: row.title,
    origin: row.origin === "pushed" ? "pushed" : "pulled",
    status: row.status,
    stage: stage.success ? stage.data : null,
    mrs,
    syncedAt: row.synced_at,
    error: row.error,
  };
}

/** Which task is linked to which tracker item (5.11), and what majhi wrote back to it. */
export class TrackerLinkRepo {
  constructor(private readonly sqlite: Database.Database) {}

  get(task: string): TrackerLink | undefined {
    const row = this.sqlite.prepare(`${SELECT} WHERE l.task = ?`).get(task) as Row | undefined;
    return row === undefined ? undefined : toLink(row);
  }

  /** The task of an org linked to that item, when there is one. */
  byKey(org: string, type: string, key: string): TrackerLink | undefined {
    const row = this.sqlite
      .prepare(`${SELECT} WHERE t.org = ? AND l.type = ? AND l.key = ?`)
      .get(org, type, key) as Row | undefined;
    return row === undefined ? undefined : toLink(row);
  }

  list(): TrackerLink[] {
    return (this.sqlite.prepare(SELECT).all() as Row[]).map(toLink);
  }

  forOrg(org: string): TrackerLink[] {
    return (this.sqlite.prepare(`${SELECT} WHERE t.org = ?`).all(org) as Row[]).map(toLink);
  }

  put(link: Omit<TrackerLink, "org">): void {
    this.sqlite
      .prepare(
        `INSERT INTO tracker_links (task, type, key, url, title, origin, status, stage, mrs, synced_at, error)
         VALUES (@task, @type, @key, @url, @title, @origin, @status, @stage, @mrs, @syncedAt, @error)
         ON CONFLICT (task) DO UPDATE SET type = excluded.type, key = excluded.key, url = excluded.url,
           title = excluded.title, origin = excluded.origin, status = excluded.status, stage = excluded.stage,
           mrs = excluded.mrs, synced_at = excluded.synced_at, error = excluded.error`,
      )
      .run({ ...link, mrs: JSON.stringify(link.mrs) });
  }

  /** Records a write-back: the fields given, the time, and the error (null when it worked). */
  update(
    task: string,
    patch: { status?: string; title?: string; stage?: TrackerLink["stage"]; mrs?: string[] },
    at: string,
    error: string | null,
  ): void {
    const link = this.get(task);
    if (link === undefined) return;
    this.put({ ...link, ...patch, syncedAt: at, error });
  }

  remove(task: string): boolean {
    return this.sqlite.prepare("DELETE FROM tracker_links WHERE task = ?").run(task).changes > 0;
  }
}
