import {
  type Attachment,
  type PausedReason,
  type Task,
  type TaskId,
  TaskIdSchema,
  TaskLinkTypeSchema,
  TaskSchema,
  type TaskStatus,
  type TaskSummary,
} from "@majhi/shared";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db.ts";
import { attachments, taskCounters, taskLinks, taskRepos, tasks } from "./schema.ts";

const TeamSchema = z.array(z.string());

/** A task row with its repos, links and attachments, as the store keeps it. */
export class TaskRepo {
  constructor(private readonly db: Db) {}

  /** Hands out the next id for a key prefix: `GLX-1`, `GLX-2`, ... Numbers are never reused. */
  allocateKey(prefix: string): TaskId {
    const row = this.db
      .insert(taskCounters)
      .values({ prefix, last: 1 })
      .onConflictDoUpdate({ target: taskCounters.prefix, set: { last: sql`${taskCounters.last} + 1` } })
      .returning({ last: taskCounters.last })
      .get();
    return TaskIdSchema.parse(`${prefix}-${row.last}`);
  }

  insert(task: Task): void {
    this.db.transaction((tx) => {
      tx.insert(tasks)
        .values({
          id: task.id,
          title: task.title,
          brief: task.brief,
          kind: task.kind,
          org: task.org ?? null,
          status: task.status,
          pausedReason: task.pausedReason ?? null,
          folder: task.folder,
          team: JSON.stringify(task.team),
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        })
        .run();
      task.repos.forEach((r, pos) => {
        tx.insert(taskRepos)
          .values({
            task: task.id,
            project: r.project,
            source: r.source,
            base: r.base,
            branch: r.branch,
            worktree: r.worktree ?? null,
            createdBranch: r.createdBranch,
            pos,
          })
          .run();
      });
      for (const l of task.links) {
        tx.insert(taskLinks)
          .values({ task: task.id, type: l.type, other: l.task, when: l.when ?? null })
          .run();
      }
      task.attachments.forEach((a, pos) => {
        tx.insert(attachments)
          .values(attachmentRow(task.id, a, pos))
          .run();
      });
    });
  }

  get(id: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (row === undefined) return undefined;
    const repos = this.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.task, id))
      .orderBy(asc(taskRepos.pos))
      .all();
    const links = this.db.select().from(taskLinks).where(eq(taskLinks.task, id)).all();
    const files = this.db
      .select()
      .from(attachments)
      .where(eq(attachments.task, id))
      .orderBy(asc(attachments.pos))
      .all();
    return TaskSchema.parse({
      id: row.id,
      title: row.title,
      brief: row.brief,
      kind: row.kind,
      ...(row.org === null ? {} : { org: row.org }),
      status: row.status,
      ...(row.pausedReason === null ? {} : { pausedReason: row.pausedReason }),
      folder: row.folder,
      repos: repos.map((r) => ({
        project: r.project,
        source: r.source,
        base: r.base,
        branch: r.branch,
        ...(r.worktree === null ? {} : { worktree: r.worktree }),
        createdBranch: r.createdBranch,
      })),
      team: TeamSchema.parse(JSON.parse(row.team)),
      links: links.map((l) => ({
        type: TaskLinkTypeSchema.parse(l.type),
        task: l.other,
        ...(l.when === null ? {} : { when: l.when }),
      })),
      attachments: files.map(attachmentFromRow),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  /** Newest first. Two queries however many tasks there are. `working` is filled by the caller. */
  list(includeDone: boolean): Omit<TaskSummary, "working">[] {
    const rows = this.db
      .select()
      .from(tasks)
      .where(includeDone ? undefined : ne(tasks.status, "done"))
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
      .all();
    const repos = this.db
      .select({ task: taskRepos.task, project: taskRepos.project, branch: taskRepos.branch })
      .from(taskRepos)
      .orderBy(asc(taskRepos.pos))
      .all();
    const byTask = new Map<string, { project: string; branch: string }[]>();
    for (const r of repos) {
      const list = byTask.get(r.task) ?? [];
      list.push({ project: r.project, branch: r.branch });
      byTask.set(r.task, list);
    }
    return rows.map((row) => {
      const summary: Omit<TaskSummary, "working"> = {
        id: TaskIdSchema.parse(row.id),
        title: row.title,
        kind: TaskSchema.shape.kind.parse(row.kind),
        status: TaskSchema.shape.status.parse(row.status),
        team: TeamSchema.parse(JSON.parse(row.team)),
        updatedAt: row.updatedAt,
        repos: byTask.get(row.id) ?? [],
        // Filled from task_links by the task links work in Phase 2b.
        links: [],
        waitingOn: [],
      };
      if (row.org !== null) summary.org = row.org;
      if (row.pausedReason !== null)
        summary.pausedReason = TaskSchema.shape.pausedReason.unwrap().parse(row.pausedReason);
      return summary;
    });
  }

  setStatus(id: string, status: TaskStatus, pausedReason: PausedReason | undefined, at: string): void {
    this.db
      .update(tasks)
      .set({ status, pausedReason: pausedReason ?? null, updatedAt: at })
      .where(eq(tasks.id, id))
      .run();
  }

  touch(id: string, at: string): void {
    this.db.update(tasks).set({ updatedAt: at }).where(eq(tasks.id, id)).run();
  }

  setWorktree(task: string, project: string, worktree: string, createdBranch: boolean): void {
    this.db
      .update(taskRepos)
      .set({ worktree, createdBranch })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  addAttachments(task: string, added: readonly Attachment[]): void {
    this.db.transaction((tx) => {
      const last = tx
        .select({ pos: sql<number>`coalesce(max(${attachments.pos}), -1)` })
        .from(attachments)
        .where(eq(attachments.task, task))
        .get();
      let pos = (last?.pos ?? -1) + 1;
      for (const a of added)
        tx.insert(attachments)
          .values(attachmentRow(task, a, pos++))
          .run();
    });
  }

  remove(id: string): void {
    this.db.delete(tasks).where(eq(tasks.id, id)).run();
  }

  /** Ids of tasks that are not done and use the project. */
  openTasksUsing(project: string): string[] {
    return this.db
      .select({ id: taskRepos.task })
      .from(taskRepos)
      .innerJoin(tasks, eq(tasks.id, taskRepos.task))
      .where(and(eq(taskRepos.project, project), ne(tasks.status, "done")))
      .all()
      .map((r) => r.id);
  }
}

function attachmentRow(task: string, a: Attachment, pos: number) {
  return {
    task,
    id: a.id,
    kind: a.kind,
    name: a.name,
    mime: a.mime ?? null,
    size: a.size ?? null,
    url: a.url ?? null,
    path: a.path ?? null,
    error: a.error ?? null,
    pos,
  };
}

function attachmentFromRow(r: typeof attachments.$inferSelect): Attachment {
  const out: Record<string, unknown> = { id: r.id, kind: r.kind, name: r.name };
  if (r.mime !== null) out.mime = r.mime;
  if (r.size !== null) out.size = r.size;
  if (r.url !== null) out.url = r.url;
  if (r.path !== null) out.path = r.path;
  if (r.error !== null) out.error = r.error;
  return TaskSchema.shape.attachments.element.parse(out);
}
