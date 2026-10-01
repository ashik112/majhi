import {
  type Attachment,
  type CoordinationMode,
  CoordinationModeSchema,
  isOwnerChat,
  type PausedReason,
  type PendingShip,
  PendingShipSchema,
  type ReadMount,
  ReadMountSchema,
  type RepoMr,
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
import { and, asc, desc, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { parseRoomState, type RoomState } from "../rooms/state.ts";
import { type LinkRow, parentIsComplete, unmetDependencies } from "../tasks/relations.ts";
import type { Db } from "./db.ts";
import { attachments, taskCounters, taskLinks, taskRepos, tasks } from "./schema.ts";

const TeamSchema = z.array(z.string());
const OverridesSchema = z.record(z.string(), TeamOverrideSchema);

/** A stored pending ship, or undefined when there is none or it no longer parses. */
function parsePendingShip(json: string | null): PendingShip | undefined {
  if (json === null) return undefined;
  try {
    const parsed = PendingShipSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const ReadMountsSchema = z.array(ReadMountSchema);

function parseReadMounts(json: string): ReadMount[] {
  try {
    const parsed = ReadMountsSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

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
          readMounts: JSON.stringify(ReadMountsSchema.parse(task.readMounts ?? [])),
          pendingShip: task.pendingShip === undefined ? null : JSON.stringify(task.pendingShip),
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
            mergeOrder: r.mergeOrder ?? null,
            mrUrl: r.mr?.url ?? null,
            mrNumber: r.mr?.number ?? null,
            mrState: r.mr?.state ?? null,
            ciState: r.mr?.ci ?? null,
            pushedAt: r.pushedAt ?? null,
            startCommit: r.startCommit ?? null,
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
    const pending = parsePendingShip(row.pendingShip);
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
        ...(r.mergeOrder === null ? {} : { mergeOrder: r.mergeOrder }),
        ...(r.pushedAt === null ? {} : { pushedAt: r.pushedAt }),
        ...(r.startCommit === null ? {} : { startCommit: r.startCommit }),
        ...(r.mrUrl === null || r.mrNumber === null || r.mrState === null
          ? {}
          : { mr: { url: r.mrUrl, number: r.mrNumber, state: r.mrState, ci: r.ciState ?? "none" } }),
      })),
      team: TeamSchema.parse(JSON.parse(row.team)),
      mode: CoordinationModeSchema.catch("lead").parse(row.mode),
      overrides: parseOverrides(row.overrides),
      ...(row.readMounts === "[]" ? {} : { readMounts: parseReadMounts(row.readMounts) }),
      links: links.map((l) => ({
        type: TaskLinkTypeSchema.parse(l.type),
        task: l.other,
        ...(l.when === null ? {} : { when: l.when }),
      })),
      attachments: files.map(attachmentFromRow),
      ...(pending === undefined ? {} : { pendingShip: pending }),
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
    const unmerged = this.unmergedMrs();
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
        waitingOn: unmetDependencies(
          own,
          (id) => statuses.get(id),
          (id) => unmerged.has(id),
        ),
      };
      if (kids !== undefined)
        summary.children = { total: kids.length, done: kids.filter((k) => k === "done").length };
      if (row.org !== null) summary.org = row.org;
      if (isOwnerChat({ kind: summary.kind, brief: row.brief })) summary.chat = true;
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
    const unmerged = this.unmergedMrs();
    return unmetDependencies(
      own,
      (other) => statuses.get(other),
      (other) => unmerged.has(other),
    );
  }

  /** Tasks with a merge request that is not merged: open, or closed without merging. */
  unmergedMrs(): Set<string> {
    return new Set(
      this.db
        .selectDistinct({ task: taskRepos.task })
        .from(taskRepos)
        .where(and(isNotNull(taskRepos.mrState), ne(taskRepos.mrState, "merged")))
        .all()
        .map((r) => r.task),
    );
  }

  /** Done tasks that still have an open merge request, so their merge can be noticed. */
  doneWithOpenMrs(): string[] {
    return [
      ...new Set(
        this.db
          .select({ task: taskRepos.task })
          .from(taskRepos)
          .innerJoin(tasks, eq(tasks.id, taskRepos.task))
          .where(and(eq(tasks.status, "done"), eq(taskRepos.mrState, "open")))
          .all()
          .map((r) => r.task),
      ),
    ];
  }

  /** Done tasks last updated before `before` (an ISO time), oldest first, with the time. */
  doneBefore(before: string): { id: string; doneAt: string }[] {
    return this.db
      .select({ id: tasks.id, doneAt: tasks.updatedAt })
      .from(tasks)
      .where(and(eq(tasks.status, "done"), lt(tasks.updatedAt, before)))
      .orderBy(asc(tasks.updatedAt))
      .all();
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

  setReadMounts(id: string, mounts: readonly ReadMount[], at: string): void {
    this.db
      .update(tasks)
      .set({ readMounts: JSON.stringify(ReadMountsSchema.parse(mounts)), updatedAt: at })
      .where(eq(tasks.id, id))
      .run();
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

  /** The ship waiting for the lead, if any. */
  pendingShip(id: string): PendingShip | undefined {
    const row = this.db.select({ v: tasks.pendingShip }).from(tasks).where(eq(tasks.id, id)).get();
    return parsePendingShip(row?.v ?? null);
  }

  /** Sets or clears (undefined) the ship waiting for the lead. */
  setPendingShip(id: string, pending: PendingShip | undefined): void {
    this.db
      .update(tasks)
      .set({ pendingShip: pending === undefined ? null : JSON.stringify(PendingShipSchema.parse(pending)) })
      .where(eq(tasks.id, id))
      .run();
  }

  /**
   * Clears the ship waiting for the lead and returns it, or undefined when none was set. A ship
   * taken this way is gone before it runs, so one click runs it at most once.
   */
  takePendingShip(id: string): PendingShip | undefined {
    const pending = this.pendingShip(id);
    if (pending !== undefined) this.setPendingShip(id, undefined);
    return pending;
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

  setWorktree(
    task: string,
    project: string,
    worktree: string,
    createdBranch: boolean,
    startCommit?: string,
  ): void {
    this.db
      .update(taskRepos)
      .set({ worktree, createdBranch, ...(startCommit === undefined ? {} : { startCommit }) })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** Forgets a worktree that was removed after the merge. The branch and the task stay. */
  clearWorktree(task: string, project: string): void {
    this.db
      .update(taskRepos)
      .set({ worktree: null })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** The owner's merge order: `order` lists every project of the task once. null goes back to project links. */
  setMergeOrder(task: string, order: readonly string[] | null): void {
    this.db.transaction((tx) => {
      tx.update(taskRepos).set({ mergeOrder: null }).where(eq(taskRepos.task, task)).run();
      order?.forEach((project, position) => {
        tx.update(taskRepos)
          .set({ mergeOrder: position })
          .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
          .run();
      });
    });
  }

  /** The branch reached the MR remote. */
  setPushed(task: string, project: string, at: string): void {
    this.db
      .update(taskRepos)
      .set({ pushedAt: at })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** The repo's MR as its host reports it. */
  setMr(task: string, project: string, mr: RepoMr): void {
    this.db
      .update(taskRepos)
      .set({ mrUrl: mr.url, mrNumber: mr.number, mrState: mr.state, ciState: mr.ci })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** Task ids in one of these statuses, oldest first. */
  idsWithStatus(status: TaskStatus): string[] {
    return this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, status))
      .orderBy(asc(tasks.updatedAt))
      .all()
      .map((r) => r.id);
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
