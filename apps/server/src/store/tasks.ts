import {
  type Attachment,
  AUTONOMY_CHAT_BRIEF,
  BOSS_CHAT_BRIEF,
  CAPTAIN_LANE_BRIEF,
  CHAT_BRIEF,
  type CiState,
  CiStateSchema,
  type CoordinationMode,
  CoordinationModeSchema,
  DaySchema,
  IdSchema,
  isCaptainLane,
  isOwnerChat,
  type MrReview,
  MrReviewSchema,
  type PendingShip,
  PendingShipSchema,
  type ReadMount,
  ReadMountSchema,
  type RepoMr,
  type Task,
  type TaskId,
  TaskIdSchema,
  TaskLinkTypeSchema,
  type TaskPriority,
  TaskPrioritySchema,
  TaskSchema,
  type TaskStatus,
  type TaskSummary,
  type TeamOverride,
  TeamOverrideSchema,
} from "@majhi/shared";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { parseRoomState, type RoomState } from "../rooms/state.ts";
import { type LinkRow, parentIsComplete, unmetDependencies } from "../tasks/relations.ts";
import type { Db } from "./db.ts";
import { attachments, autonomyTasks, taskCounters, taskLinks, taskRepos, tasks } from "./schema.ts";
import { parseRows } from "./tolerant.ts";

/** The briefs that make a `chat` task the owner's chat or a captain lane (see `isOwnerChat`). */
const OWNER_CHAT_BRIEFS = [CHAT_BRIEF, BOSS_CHAT_BRIEF, AUTONOMY_CHAT_BRIEF, CAPTAIN_LANE_BRIEF];

const TeamSchema = z.array(z.string());
const OverridesSchema = z.record(z.string(), TeamOverrideSchema);

/** The stored reviews of an MR as a spreadable field, or nothing when there are none or they no longer parse. */
function reviewOf(json: string | null): { review?: MrReview } {
  if (json === null) return {};
  try {
    const parsed = MrReviewSchema.safeParse(JSON.parse(json));
    return parsed.success ? { review: parsed.data } : {};
  } catch {
    return {};
  }
}

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
const ConnectionIdsSchema = z.array(IdSchema);

/** The task's connection ids. A row that does not parse reads as none. */
function parseConnectionIds(json: string): string[] {
  try {
    return ConnectionIdsSchema.catch([]).parse(JSON.parse(json));
  } catch {
    return [];
  }
}

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
  private subjectQueries: ReturnType<typeof subjectStatements> | undefined;
  private prepared: ReturnType<typeof taskStatements> | undefined;

  constructor(private readonly db: Db) {}

  /** The hot queries, built and prepared once (Drizzle builds and prepares a plain query on every call). */
  private get q(): ReturnType<typeof taskStatements> {
    this.prepared ??= taskStatements(this.db);
    return this.prepared;
  }

  /**
   * What a notice or a decision names a task by: id, title, kind, brief, workspace, status and how many
   * repos. Two prepared queries where `get` builds four from scratch, for lists that ask per item.
   */
  subjectInfo(id: string): TaskSubjectInfo | undefined {
    this.subjectQueries ??= subjectStatements(this.db);
    const row = this.subjectQueries.row.get({ id });
    if (row === undefined) return undefined;
    const repos = this.subjectQueries.repos.get({ id })?.n ?? 0;
    return {
      id: row.id,
      title: row.title,
      kind: TaskSchema.shape.kind.parse(row.kind),
      brief: row.brief,
      ...(row.org === null ? {} : { org: row.org }),
      status: TaskSchema.shape.status.parse(row.status),
      repos,
    };
  }

  /**
   * `subjectInfo` and `openSubtasks` of many tasks in three queries however many ids there are. A task
   * that does not exist is left out.
   */
  subjectsMany(ids: readonly string[]): Map<string, TaskSubjectInfo & { open: number; newest?: string }> {
    const out = new Map<string, TaskSubjectInfo & { open: number; newest?: string }>();
    if (ids.length === 0) return out;
    this.subjectQueries ??= subjectStatements(this.db);
    const params = { ids: JSON.stringify(ids) };
    const repos = new Map(this.subjectQueries.reposIn.all(params).map((r) => [r.task, r.n]));
    const open = new Map(this.subjectQueries.openIn.all(params).map((r) => [r.parent, r]));
    for (const row of this.subjectQueries.rowsIn.all(params)) {
      const kids = open.get(row.id);
      out.set(row.id, {
        id: row.id,
        title: row.title,
        kind: TaskSchema.shape.kind.parse(row.kind),
        brief: row.brief,
        ...(row.org === null ? {} : { org: row.org }),
        status: TaskSchema.shape.status.parse(row.status),
        repos: repos.get(row.id) ?? 0,
        open: kids?.n ?? 0,
        ...(kids?.newest == null ? {} : { newest: kids.newest }),
      });
    }
    return out;
  }

  /**
   * The subtasks of a parent that are not done, and when the newest one was made. A parent with open
   * subtasks waits on them, not on the owner.
   */
  openSubtasks(parent: string): { open: number; newest?: string } {
    const row = this.db
      .select({ n: sql<number>`count(*)`, newest: sql<string | null>`max(${tasks.createdAt})` })
      .from(taskLinks)
      .innerJoin(tasks, eq(tasks.id, taskLinks.task))
      .where(and(eq(taskLinks.type, "parent"), eq(taskLinks.other, parent), ne(tasks.status, "done")))
      .get();
    return { open: row?.n ?? 0, ...(row?.newest == null ? {} : { newest: row.newest }) };
  }

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
          pausedBy: task.pausedBy ?? null,
          folder: task.folder,
          team: JSON.stringify(task.team),
          mode: task.mode,
          overrides: JSON.stringify(task.overrides),
          readMounts: JSON.stringify(ReadMountsSchema.parse(task.readMounts ?? [])),
          connections: JSON.stringify(ConnectionIdsSchema.parse(task.connections ?? [])),
          pendingShip: task.pendingShip === undefined ? null : JSON.stringify(task.pendingShip),
          priority: task.priority ?? null,
          due: task.due ?? null,
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
            mrReview: r.mr?.review === undefined ? null : JSON.stringify(r.mr.review),
            pushedAt: r.pushedAt ?? null,
            shippedHead: r.shipped?.head ?? null,
            shippedInto: r.shipped?.into ?? null,
            startCommit: r.startCommit ?? null,
            writes: r.writes === true,
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

  /** Whether the task exists: one cheap query where `get` runs four. */
  has(id: string): boolean {
    return this.q.has.get({ id }) !== undefined;
  }

  get(id: string): Task | undefined {
    const row = this.q.row.get({ id });
    if (row === undefined) return undefined;
    return buildTask(row, this.q.repos.all({ id }), this.q.links.all({ id }), this.q.files.all({ id }));
  }

  /**
   * Several tasks in four queries however many ids there are (`get` runs four per task). Ids that do not
   * exist are left out; the rest keep the order asked for.
   */
  getMany(ids: readonly string[]): Task[] {
    if (ids.length === 0) return [];
    const params = { ids: JSON.stringify(ids) };
    const rows = this.q.rowsIn.all(params);
    const repos = groupBy(this.q.reposIn.all(params), (r) => r.task);
    const links = groupBy(this.q.linksIn.all(params), (r) => r.task);
    const files = groupBy(this.q.filesIn.all(params), (r) => r.task);
    const found = new Map<string, Task>();
    // A task that does not parse is left out and logged once, so one bad row cannot fail the whole read.
    for (const task of parseRows(
      "tasks",
      rows,
      (r) => r.id,
      (row) => buildTask(row, repos.get(row.id) ?? [], links.get(row.id) ?? [], files.get(row.id) ?? []),
    ))
      found.set(task.id, task);
    return ids.flatMap((id) => found.get(id) ?? []);
  }

  /**
   * Tasks that wait to start (inbox or ready, with start-when-ready on), oldest first, loaded in one
   * pass. The orchestrator asks on every sweep, so it must not load every task to find them.
   */
  waitingToStart(): Task[] {
    return this.getMany(this.q.waitingIds.all().map((r) => r.id));
  }

  /** The tasks running now other than `except`, newest first, loaded in one pass. */
  runningTasks(except: string): Task[] {
    return this.getMany(
      this.q.runningIds
        .all()
        .map((r) => r.id)
        .filter((id) => id !== except),
    );
  }

  /** Ids of the owner's chats and the captain's lanes. */
  chatIds(): string[] {
    return this.q.chatIds.all().map((r) => r.id);
  }

  /** Newest first. Two queries however many tasks there are. `working` is filled by the caller. */
  list(includeDone: boolean, only?: readonly string[]): Omit<TaskSummary, "working">[] {
    const rows =
      only !== undefined
        ? this.q.rowsIn.all({ ids: JSON.stringify(only) }).filter((r) => includeDone || r.status !== "done")
        : includeDone
          ? this.q.listAll.all()
          : this.q.listOpen.all();
    // `pos` orders a task's repos; sorting here saves SQLite a temp sort of every repo row on each call.
    const repos = this.q.repoSummaries.all().sort((a, b) => a.pos - b.pos);
    const byTask = new Map<string, { project: string; branch: string }[]>();
    for (const r of repos) {
      const list = byTask.get(r.task) ?? [];
      list.push({ project: r.project, branch: r.branch });
      byTask.set(r.task, list);
    }
    const linkRows = this.allLinks();
    const statuses = this.statuses();
    const unmerged = this.unmergedMrs();
    const autonomous = new Set(this.q.autonomous.all().map((r) => r.task));
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
    return parseRows(
      "tasks",
      rows,
      (r) => r.id,
      (row) => {
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
        if (isCaptainLane({ kind: summary.kind, brief: row.brief })) summary.lane = true;
        if (row.pausedReason !== null)
          summary.pausedReason = TaskSchema.shape.pausedReason.unwrap().parse(row.pausedReason);
        if (row.pausedBy !== null) summary.pausedBy = TaskSchema.shape.pausedBy.unwrap().parse(row.pausedBy);
        Object.assign(summary, priorityAndDue(row));
        if (row.noAutonomy) summary.noAutonomy = true;
        if (autonomous.has(row.id)) summary.autonomous = true;
        return summary;
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Links (5.4a)

  /** Every link, one query. */
  allLinks(): LinkRow[] {
    return parseRows(
      "task_links",
      this.q.allLinks.all(),
      (l) => `${l.task}/${l.type}/${l.other}`,
      (l) => ({
        task: l.task,
        type: TaskLinkTypeSchema.parse(l.type),
        other: l.other,
        when: l.when === null ? undefined : (l.when as "merged" | "ready"),
      }),
    );
  }

  /** Status of every task, one query. */
  statuses(): Map<string, TaskStatus> {
    return new Map(
      parseRows(
        "tasks",
        this.q.statusRows.all(),
        (r) => r.id,
        (r): [string, TaskStatus] => [r.id, TaskSchema.shape.status.parse(r.status)],
      ),
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

  /** The open merge requests of every task, for the Shipping rows of Home. One query. */
  openMrs(): { task: string; project: string; number: number; url: string; ci: CiState }[] {
    return this.db
      .select({
        task: taskRepos.task,
        project: taskRepos.project,
        number: taskRepos.mrNumber,
        url: taskRepos.mrUrl,
        ci: taskRepos.ciState,
      })
      .from(taskRepos)
      .where(eq(taskRepos.mrState, "open"))
      .orderBy(asc(taskRepos.task), asc(taskRepos.pos))
      .all()
      .flatMap((r) =>
        r.number === null || r.url === null
          ? []
          : [
              {
                task: r.task,
                project: r.project,
                number: r.number,
                url: r.url,
                ci: CiStateSchema.catch("none").parse(r.ci),
              },
            ],
      );
  }

  /** Tasks with a merge request that is not merged: open, or closed without merging. */
  unmergedMrs(): Set<string> {
    return new Set(this.q.unmerged.all().map((r) => r.task));
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
    return this.q.startWhenReady.get({ id })?.v === 1;
  }

  setStartWhenReady(id: string, value: boolean): void {
    this.db.update(tasks).set({ startWhenReady: value }).where(eq(tasks.id, id)).run();
  }

  /** The owner's priority and deadline (PRV-74). Null clears one; undefined leaves it. */
  setPlanning(
    id: string,
    patch: { priority?: TaskPriority | null | undefined; due?: string | null | undefined },
    at: string,
  ): void {
    const set: { priority?: string | null; due?: string | null; updatedAt: string } = { updatedAt: at };
    // Normal is the default, so it is stored as nothing.
    if (patch.priority !== undefined) set.priority = patch.priority === "normal" ? null : patch.priority;
    if (patch.due !== undefined) set.due = patch.due;
    this.db.update(tasks).set(set).where(eq(tasks.id, id)).run();
  }

  /** The owner's mark Not for autonomous mode. It does not move the task in the lists. */
  setNoAutonomy(id: string, on: boolean): void {
    this.db.update(tasks).set({ noAutonomy: on }).where(eq(tasks.id, id)).run();
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

  setConnections(id: string, connections: readonly string[], at: string): void {
    this.db
      .update(tasks)
      .set({ connections: JSON.stringify(ConnectionIdsSchema.parse(connections)), updatedAt: at })
      .where(eq(tasks.id, id))
      .run();
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

  /** majhi merged the branch at `head` into `into`. */
  setShipped(task: string, project: string, head: string, into: string): void {
    this.db
      .update(taskRepos)
      .set({ shippedHead: head, shippedInto: into })
      .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
      .run();
  }

  /** The branch a repo's worktree is cut from. Only before the worktree exists. */
  setRepoBase(task: string, project: string, base: string, at: string): void {
    this.db.transaction((tx) => {
      tx.update(taskRepos)
        .set({ base })
        .where(and(eq(taskRepos.task, task), eq(taskRepos.project, project)))
        .run();
      tx.update(tasks).set({ updatedAt: at }).where(eq(tasks.id, task)).run();
    });
  }

  /** The repo's MR as its host reports it. */
  setMr(task: string, project: string, mr: RepoMr): void {
    this.db
      .update(taskRepos)
      .set({
        mrUrl: mr.url,
        mrNumber: mr.number,
        mrState: mr.state,
        ciState: mr.ci,
        mrReview: mr.review === undefined ? null : JSON.stringify(mr.review),
      })
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
  /** The working branches of every task in the repo at `source`, whatever their names. */
  branchesIn(source: string): Set<string> {
    const rows = this.db
      .select({ branch: taskRepos.branch })
      .from(taskRepos)
      .where(eq(taskRepos.source, source))
      .all();
    return new Set(rows.map((r) => r.branch));
  }

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

/** A row's priority and due date, left out when unset or no longer valid. */
function priorityAndDue(row: { priority: string | null; due: string | null }): {
  priority?: TaskPriority;
  due?: string;
} {
  const priority = TaskPrioritySchema.safeParse(row.priority);
  const due = DaySchema.safeParse(row.due);
  return {
    ...(priority.success && priority.data !== "normal" ? { priority: priority.data } : {}),
    ...(due.success ? { due: due.data } : {}),
  };
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

export interface TaskSubjectInfo {
  id: string;
  title: string;
  kind: Task["kind"];
  brief: string;
  org?: string;
  status: TaskStatus;
  repos: number;
}

const ID = sql.placeholder("id");
/** The ids of a `json_each` list, so one prepared query serves any number of ids. */
const IDS = sql`(select value from json_each(${sql.placeholder("ids")}))`;

function taskStatements(db: Db) {
  return {
    has: db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, ID)).prepare(),
    row: db.select().from(tasks).where(eq(tasks.id, ID)).prepare(),
    repos: db.select().from(taskRepos).where(eq(taskRepos.task, ID)).orderBy(asc(taskRepos.pos)).prepare(),
    links: db.select().from(taskLinks).where(eq(taskLinks.task, ID)).prepare(),
    files: db
      .select()
      .from(attachments)
      .where(eq(attachments.task, ID))
      .orderBy(asc(attachments.pos))
      .prepare(),
    rowsIn: db.select().from(tasks).where(inArray(tasks.id, IDS)).prepare(),
    reposIn: db
      .select()
      .from(taskRepos)
      .where(inArray(taskRepos.task, IDS))
      .orderBy(asc(taskRepos.pos))
      .prepare(),
    linksIn: db.select().from(taskLinks).where(inArray(taskLinks.task, IDS)).prepare(),
    filesIn: db
      .select()
      .from(attachments)
      .where(inArray(attachments.task, IDS))
      .orderBy(asc(attachments.pos))
      .prepare(),
    listAll: db.select().from(tasks).orderBy(desc(tasks.updatedAt), desc(tasks.id)).prepare(),
    listOpen: db
      .select()
      .from(tasks)
      .where(ne(tasks.status, "done"))
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
      .prepare(),
    repoSummaries: db
      .select({
        task: taskRepos.task,
        project: taskRepos.project,
        branch: taskRepos.branch,
        pos: taskRepos.pos,
      })
      .from(taskRepos)
      .prepare(),
    autonomous: db.select({ task: autonomyTasks.task }).from(autonomyTasks).prepare(),
    allLinks: db.select().from(taskLinks).prepare(),
    statusRows: db.select({ id: tasks.id, status: tasks.status }).from(tasks).prepare(),
    unmerged: db
      .selectDistinct({ task: taskRepos.task })
      .from(taskRepos)
      // Literal text, so SQLite sees the same condition as the partial index (migration 153).
      .where(sql`mr_state IS NOT NULL AND mr_state != 'merged'`)
      .prepare(),
    // Raw column text, so the start-when-ready lifecycle column keeps its one reader and one writer.
    startWhenReady: db
      .select({ v: sql<number>`start_when_ready` })
      .from(tasks)
      .where(eq(tasks.id, ID))
      .prepare(),
    waitingIds: db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(inArray(tasks.status, ["inbox", "ready"]), sql`start_when_ready = 1`))
      .orderBy(asc(tasks.updatedAt), asc(tasks.id))
      .prepare(),
    runningIds: db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.status, "running"))
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
      .prepare(),
    chatIds: db
      .select({ id: tasks.id })
      .from(tasks)
      // Literal kind, so SQLite sees the same condition as the partial index (migration 153).
      .where(and(sql`kind = 'chat'`, inArray(tasks.brief, OWNER_CHAT_BRIEFS)))
      .prepare(),
  };
}

function subjectStatements(db: Db) {
  return {
    row: db
      .select({
        id: tasks.id,
        title: tasks.title,
        kind: tasks.kind,
        brief: tasks.brief,
        org: tasks.org,
        status: tasks.status,
      })
      .from(tasks)
      .where(eq(tasks.id, sql.placeholder("id")))
      .prepare(),
    repos: db
      .select({ n: sql<number>`count(*)` })
      .from(taskRepos)
      .where(eq(taskRepos.task, sql.placeholder("id")))
      .prepare(),
    rowsIn: db
      .select({
        id: tasks.id,
        title: tasks.title,
        kind: tasks.kind,
        brief: tasks.brief,
        org: tasks.org,
        status: tasks.status,
      })
      .from(tasks)
      .where(inArray(tasks.id, IDS))
      .prepare(),
    reposIn: db
      .select({ task: taskRepos.task, n: sql<number>`count(*)` })
      .from(taskRepos)
      .where(inArray(taskRepos.task, IDS))
      .groupBy(taskRepos.task)
      .prepare(),
    openIn: db
      .select({
        parent: taskLinks.other,
        n: sql<number>`count(*)`,
        newest: sql<string | null>`max(${tasks.createdAt})`,
      })
      .from(taskLinks)
      .innerJoin(tasks, eq(tasks.id, taskLinks.task))
      .where(and(eq(taskLinks.type, "parent"), inArray(taskLinks.other, IDS), ne(tasks.status, "done")))
      .groupBy(taskLinks.other)
      .prepare(),
  };
}

/** A task from its rows. `get` and `getMany` share it. */
function buildTask(
  row: typeof tasks.$inferSelect,
  repos: (typeof taskRepos.$inferSelect)[],
  links: (typeof taskLinks.$inferSelect)[],
  files: (typeof attachments.$inferSelect)[],
): Task {
  const pending = parsePendingShip(row.pendingShip);
  return TaskSchema.parse({
    id: row.id,
    title: row.title,
    brief: row.brief,
    kind: row.kind,
    ...(row.org === null ? {} : { org: row.org }),
    status: row.status,
    ...(row.pausedReason === null ? {} : { pausedReason: row.pausedReason }),
    ...(row.pausedBy === null ? {} : { pausedBy: row.pausedBy }),
    ...priorityAndDue(row),
    ...(row.noAutonomy ? { noAutonomy: true } : {}),
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
      ...(r.shippedHead === null || r.shippedInto === null
        ? {}
        : { shipped: { head: r.shippedHead, into: r.shippedInto } }),
      ...(r.startCommit === null ? {} : { startCommit: r.startCommit }),
      ...(r.writes ? { writes: true } : {}),
      ...(r.mrUrl === null || r.mrNumber === null || r.mrState === null
        ? {}
        : {
            mr: {
              url: r.mrUrl,
              number: r.mrNumber,
              state: r.mrState,
              ci: r.ciState ?? "none",
              ...reviewOf(r.mrReview),
            },
          }),
    })),
    team: TeamSchema.parse(JSON.parse(row.team)),
    mode: CoordinationModeSchema.catch("lead").parse(row.mode),
    overrides: parseOverrides(row.overrides),
    ...(row.readMounts === "[]" ? {} : { readMounts: parseReadMounts(row.readMounts) }),
    ...(row.connections === "[]" ? {} : { connections: parseConnectionIds(row.connections) }),
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

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const own = out.get(k);
    if (own === undefined) out.set(k, [r]);
    else own.push(r);
  }
  return out;
}
