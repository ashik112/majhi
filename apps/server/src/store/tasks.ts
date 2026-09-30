import {
  type Attachment,
  type CoordinationMode,
  CoordinationModeSchema,
  type PausedReason,
  type Task,
  type TaskId,
  TaskIdSchema,
  TaskLinkTypeSchema,
  TaskSchema,
  type TaskStatus,
  type TaskSummary,
  type TeamOverride,
  TeamOverrideSchema,
} from "@majhi/shared";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { parseRoomState, type RoomState } from "../rooms/state.ts";
import { type LinkRow, parentIsComplete, unmetDependencies } from "../tasks/relations.ts";
import type { Db } from "./db.ts";
import { attachments, taskCounters, taskLinks, taskRepos, tasks } from "./schema.ts";

const TeamSchema = z.array(z.string());
const OverridesSchema = z.record(z.string(), TeamOverrideSchema);

function parseOverrides(json: string): Record<string, TeamOverride> {
  try {
    const parsed = OverridesSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

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
          mode: task.mode,
          overrides: JSON.stringify(task.overrides),
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
            stackTask: r.stack?.task ?? null,
            stackBranch: r.stack?.branch ?? null,
            stackCommit: r.stack?.commit ?? null,
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
        ...(r.stackTask === null || r.stackBranch === null || r.stackCommit === null
          ? {}
          : { stack: { task: r.stackTask, branch: r.stackBranch, commit: r.stackCommit } }),
      })),
      team: TeamSchema.parse(JSON.parse(row.team)),
      mode: CoordinationModeSchema.catch("lead").parse(row.mode),
      overrides: parseOverrides(row.overrides),
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
    const linkRows = this.allLinks();
    const statuses = this.statuses();
    const linksBy = new Map<string, LinkRow[]>();
    const childStatuses = new Map<string, TaskStatus[]>();
    for (const l of linkRows) {
      const own = linksBy.get(l.task) ?? [];
      own.push(l);
      linksBy.set(l.task, own);
      if (l.type === "parent") {
        const kids = childStatuses.get(l.other) ?? [];
        const status = statuses.get(l.task);
        if (status !== undefined) kids.push(status);
        childStatuses.set(l.other, kids);
      }
    }
    return rows.map((row) => {
      const own = linksBy.get(row.id) ?? [];
      const kids = childStatuses.get(row.id);
      const summary: Omit<TaskSummary, "working"> = {
        id: TaskIdSchema.parse(row.id),
        title: row.title,
        kind: TaskSchema.shape.kind.parse(row.kind),
        status: TaskSchema.shape.status.parse(row.status),
        team: TeamSchema.parse(JSON.parse(row.team)),
        mode: CoordinationModeSchema.catch("lead").parse(row.mode),
        updatedAt: row.updatedAt,
        repos: byTask.get(row.id) ?? [],
        links: own.map(toLink),
        waitingOn: unmetDependencies(own, (id) => statuses.get(id)),
      };
      if (kids !== undefined)
        summary.children = { total: kids.length, done: kids.filter((k) => k === "done").length };
      if (row.org !== null) summary.org = row.org;
      if (row.pausedReason !== null)
        summary.pausedReason = TaskSchema.shape.pausedReason.unwrap().parse(row.pausedReason);
      return summary;
    });
  }

  // ---------------------------------------------------------------------------
  // Links (5.4a)

  /** Every link, one query. */
  allLinks(): LinkRow[] {
    return this.db
      .select()
      .from(taskLinks)
      .all()
      .map((l) => ({
        task: l.task,
        type: TaskLinkTypeSchema.parse(l.type),
        other: l.other,
        when: l.when === null ? undefined : (l.when as "merged" | "ready"),
      }));
  }

  /** Status of every task, one query. */
  statuses(): Map<string, TaskStatus> {
    return new Map(
      this.db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .all()
        .map((r) => [r.id, TaskSchema.shape.status.parse(r.status)]),
    );
  }

  /** Adds a link, or changes `when` on an existing one. */
  putLink(link: LinkRow): void {
    this.db
      .insert(taskLinks)
      .values({ task: link.task, type: link.type, other: link.other, when: link.when ?? null })
      .onConflictDoUpdate({
        target: [taskLinks.task, taskLinks.type, taskLinks.other],
        set: { when: link.when ?? null },
      })
      .run();
  }

  /** True when the link existed. */
  removeLink(task: string, type: string, other: string): boolean {
    return (
      this.db
        .delete(taskLinks)
        .where(and(eq(taskLinks.task, task), eq(taskLinks.type, type), eq(taskLinks.other, other)))
        .run().changes > 0
    );
  }

  /** Links other tasks hold to this one: its children and the tasks that wait for it. */
  linksTo(target: string): LinkRow[] {
    return this.allLinks().filter((l) => l.other === target);
  }

  /** Deletes the links other tasks hold to a task that is gone. */
  dropLinksTo(target: string): void {
    this.db.delete(taskLinks).where(eq(taskLinks.other, target)).run();
  }

  unmetDependencies(id: string): TaskId[] {
    const own = this.allLinks().filter((l) => l.task === id);
    const statuses = this.statuses();
    return unmetDependencies(own, (other) => statuses.get(other));
  }

  /** The ids of a parent's children, in the order they were linked. */
  children(parent: string): string[] {
    return this.allLinks()
      .filter((l) => l.type === "parent" && l.other === parent)
      .map((l) => l.task);
  }

  /** Whether every child of the parent is done. False for a parent without children. */
  childrenDone(parent: string): boolean {
    const statuses = this.statuses();
    const kids = this.allLinks().filter((l) => l.type === "parent" && l.other === parent);
    return parentIsComplete(kids.flatMap((k) => statuses.get(k.task) ?? []));
  }

  startWhenReady(id: string): boolean {
    return this.db.select({ v: tasks.startWhenReady }).from(tasks).where(eq(tasks.id, id)).get()?.v === true;
  }

  setStartWhenReady(id: string, value: boolean): void {
    this.db.update(tasks).set({ startWhenReady: value }).where(eq(tasks.id, id)).run();
  }

  setStatus(id: string, status: TaskStatus, pausedReason: PausedReason | undefined, at: string): void {
    this.db
      .update(tasks)
      .set({ status, pausedReason: pausedReason ?? null, updatedAt: at })
      .where(eq(tasks.id, id))
      .run();
  }

  /** Replaces the title and brief text of a task. */
  setText(id: string, title: string, brief: string, at: string): void {
    this.db.update(tasks).set({ title, brief, updatedAt: at }).where(eq(tasks.id, id)).run();
  }

  /** Replaces a task's team. */
  setTeam(id: string, team: readonly string[], at: string): void {
    this.db
      .update(tasks)
      .set({ team: JSON.stringify(team), updatedAt: at })
      .where(eq(tasks.id, id))
      .run();
  }

  setMode(id: string, mode: CoordinationMode, at: string): void {
    this.db.update(tasks).set({ mode, updatedAt: at }).where(eq(tasks.id, id)).run();
  }

  setOverrides(id: string, overrides: Record<string, TeamOverride>, at: string): void {
    this.db
      .update(tasks)
      .set({ overrides: JSON.stringify(overrides), updatedAt: at })
      .where(eq(tasks.id, id))
      .run();
  }

  roomState(id: string): RoomState {
    const row = this.db.select({ v: tasks.roomState }).from(tasks).where(eq(tasks.id, id)).get();
    return parseRoomState(row?.v ?? "{}");
  }

  setRoomState(id: string, state: RoomState): void {
    this.db
      .update(tasks)
      .set({ roomState: JSON.stringify(state) })
      .where(eq(tasks.id, id))
      .run();
  }

  /** Records the dependency branch a repo is stacked on, and the commit it sits on now. */
  setStack(task: string, project: string, stack: { task: string; branch: string; commit: string }): void {
    this.db
      .update(taskRepos)
      .set({ stackTask: stack.task, stackBranch: stack.branch, stackCommit: stack.commit })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** Changes the base branch a repo's worktree will be made from. Only before the worktree exists. */
  setBase(task: string, project: string, base: string): void {
    this.db
      .update(taskRepos)
      .set({ base })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** Repos of other tasks stacked on this task's branches. */
  stackedOn(task: string): { task: string; project: string; branch: string; commit: string }[] {
    return this.db
      .select()
      .from(taskRepos)
      .where(eq(taskRepos.stackTask, task))
      .all()
      .flatMap((r) =>
        r.stackBranch === null || r.stackCommit === null
          ? []
          : [{ task: r.task, project: r.project, branch: r.stackBranch, commit: r.stackCommit }],
      );
  }

  /** Renames an agent in every task team. Returns the ids of the tasks that changed. */
  renameAgent(id: string, newId: string): string[] {
    const changed: string[] = [];
    for (const row of this.db
      .select({ id: tasks.id, team: tasks.team, overrides: tasks.overrides })
      .from(tasks)
      .all()) {
      const team = TeamSchema.parse(JSON.parse(row.team));
      if (!team.includes(id)) continue;
      const next = team.map((a) => (a === id ? newId : a));
      const overrides = parseOverrides(row.overrides);
      const own = overrides[id];
      delete overrides[id];
      if (own !== undefined) overrides[newId] = own;
      this.db
        .update(tasks)
        .set({ team: JSON.stringify([...new Set(next)]), overrides: JSON.stringify(overrides) })
        .where(eq(tasks.id, row.id))
        .run();
      changed.push(row.id);
    }
    return changed;
  }

  /** Moves the tasks of one org to another org id. */
  renameOrg(id: string, newId: string): void {
    this.db.update(tasks).set({ org: newId }).where(eq(tasks.org, id)).run();
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

function toLink(l: LinkRow) {
  return {
    type: l.type,
    task: TaskIdSchema.parse(l.other),
    ...(l.when === undefined ? {} : { when: l.when }),
  };
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
