import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  type AgentFrontmatter,
  type Attachment,
  LOCAL_TASK_PREFIX,
  type ParsedTask,
  parseTaskText,
  type RoomItem,
  type Task,
  type TaskKind,
  type TaskRepo,
  type TaskSummary,
} from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import { UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { localBranchExists, remoteBranchExists, remoteOf } from "../git/git.ts";
import { createWorktree, dirtyWorktrees, removeWorktree, WorktreeProblem } from "../git/worktrees.ts";
import { orgKeys } from "../orgs/keys.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import { type FileHit, FileIndex } from "../room/files.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { UploadStore } from "../uploads/store.ts";
import { canWorkIn, pickDefaultAgent } from "./agents.ts";
import { branchName, renderPointer, renderTaskMd } from "./brief.ts";
import { fetchLinks, type LinkOptions } from "./links.ts";

export interface TaskDeps {
  store: Store;
  config: ConfigService;
  projects: ProjectService;
  agents: AgentStore;
  accounts: AccountService;
  uploads: UploadStore;
  runs: RunManager;
  room: RoomService;
  events: EventHub;
  links?: LinkOptions;
  files?: FileIndex;
  now?: () => Date;
  /** Asks the host helper to load the owner's SSH keys again. Absent without a helper. */
  reloadKeys?: () => Promise<boolean>;
}

export interface CreateInput {
  text: string;
  kind?: TaskKind | undefined;
  agent?: string | undefined;
  attachments: string[];
  start: boolean;
}

/** Creating, starting, stopping and removing tasks, and the owner's messages to a task's agent. */
export class TaskService {
  private readonly files: FileIndex;
  private readonly now: () => Date;

  constructor(private readonly deps: TaskDeps) {
    this.files = deps.files ?? new FileIndex();
    this.now = deps.now ?? (() => new Date());
  }

  list(includeDone: boolean): TaskSummary[] {
    return this.deps.store.tasks
      .list(includeDone)
      .map((t) => ({ ...t, working: this.deps.runs.working(t.id) }));
  }

  get(id: string): Task {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined) throw new UserError(`Task ${id} does not exist.`, 404);
    return task;
  }

  /** The room socket's first message, or undefined when the task does not exist. */
  snapshot(id: string) {
    const task = this.deps.store.tasks.get(id);
    return task === undefined ? undefined : this.deps.room.snapshot(task);
  }

  // ---------------------------------------------------------------------------
  // Create

  async create(input: CreateInput): Promise<Task> {
    const { store, config, uploads } = this.deps;
    const loaded = await config.load();
    if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
    const tasksDir = loaded.state.config.tasksDir;
    const sections = await config.sections();
    const projects = await this.deps.projects.infos();
    const stored = await this.deps.agents.list();
    const agents = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));

    const parsed = parseTaskText(input.text, {
      projects: projects.map((p) => ({ id: p.id, org: p.org, aliases: p.aliases })),
      agents: agents.map((a) => ({ id: a.id })),
    });
    const orgs = new Set(parsed.repos.map((r) => projects.find((p) => p.id === r.project)?.org));
    if (orgs.size > 1) {
      throw new UserError(
        `${parsed.warnings.find((w) => w.startsWith("Repos from")) ?? "Repos from more than one org"}. Make one task per org.`,
      );
    }
    const kind = input.kind ?? parsed.kind;
    if (kind === "code" && parsed.repos.length === 0) {
      throw new UserError("A code task needs a project. Name one in the text, or change the kind.");
    }
    const org = parsed.org;
    if (org !== undefined && sections.orgs[org] === undefined) {
      throw new UserError(`Org "${org}" does not exist any more. Update the project first.`, 409);
    }

    const agent = await this.chooseAgent({ input: input.agent, parsed, agents, org, boss: sections.boss });
    if (agent === undefined && input.start) {
      throw new UserError(
        org === undefined
          ? "No agent can run a task without an org. Create the boss in Studio."
          : `No agent can work in "${org}". Create one in Studio.`,
        409,
      );
    }
    await uploads.assertAll(input.attachments);

    const key =
      org === undefined ? LOCAL_TASK_PREFIX : (orgKeys(sections.orgs).get(org) ?? LOCAL_TASK_PREFIX);
    const id = store.tasks.allocateKey(key);
    const folder = join(tasksDir, id);
    const repos = await this.planRepos(id, parsed, projects);
    const at = this.now().toISOString();

    await mkdir(tasksDir, { recursive: true });
    try {
      await mkdir(folder);
    } catch {
      throw new UserError(`${folder} already exists. Move it away and try again.`, 409);
    }
    try {
      const attachmentsDir = join(folder, "attachments");
      const files: Attachment[] = [];
      for (const upload of input.attachments) files.push(await uploads.take(upload, attachmentsDir));
      const links = await fetchLinks(parsed.links, attachmentsDir, this.deps.links);

      const task: Task = {
        id,
        title: parsed.title,
        brief: input.text,
        kind,
        ...(org === undefined ? {} : { org }),
        status: input.start ? "ready" : "inbox",
        folder,
        repos,
        team: agent === undefined ? [] : [agent],
        links: [],
        attachments: [...files, ...links],
        createdAt: at,
        updatedAt: at,
      };
      await this.writeBriefFiles(task, agents, sections.orgs[org ?? ""]?.name);
      store.tasks.insert(task);
    } catch (err) {
      await rm(folder, { recursive: true, force: true });
      throw err;
    }

    for (const w of parsed.warnings) this.warn(id, w);
    let task = this.get(id);
    this.deps.room.publishTask(task);
    if (input.start) {
      try {
        task = await this.start(id);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        throw new UserError(
          `Task ${id} was created but did not start: ${why}`,
          err instanceof UserError ? err.status : 409,
        );
      }
    }
    return task;
  }

  private async chooseAgent(args: {
    input: string | undefined;
    parsed: ParsedTask;
    agents: readonly AgentFrontmatter[];
    org: string | undefined;
    boss: string | undefined;
  }): Promise<string | undefined> {
    const { input, parsed, agents, org, boss } = args;
    const requested = input ?? parsed.mentions[0];
    if (requested !== undefined) {
      const found = agents.find((a) => a.id === requested);
      if (found === undefined) throw new UserError(`Agent "${requested}" does not exist or is invalid.`);
      if (!canWorkIn(found, org)) {
        throw new UserError(
          org === undefined
            ? `@${requested} works in "${found.scope}", and this task has no org.`
            : `@${requested} cannot work in "${org}".`,
        );
      }
      return requested;
    }
    const views = await this.deps.accounts.list();
    return pickDefaultAgent({
      agents,
      org,
      boss,
      accountStatus: new Map(views.map((v) => [v.id, v.status])),
    });
  }

  private async planRepos(
    id: string,
    parsed: ParsedTask,
    projects: readonly ProjectInfo[],
  ): Promise<TaskRepo[]> {
    const repos: TaskRepo[] = [];
    for (const match of parsed.repos) {
      const project = projects.find((p) => p.id === match.project);
      if (project === undefined) continue;
      if (!project.exists) throw new UserError(`${project.path} is not a git repo the server can see.`, 409);
      const base = parsed.base ?? project.base;
      if (base === undefined)
        throw new UserError(`Project "${project.id}" has no base branch. Set one on the project.`);
      const branch = parsed.branch ?? branchName(id, parsed.title);
      const exists = parsed.branch !== undefined && (await branchExists(project.path, branch));
      // No worktree yet. It will be `<folder>/<project>`, which TASK.md names.
      repos.push({ project: project.id, source: project.path, base, branch, createdBranch: !exists });
    }
    return repos;
  }

  private async writeBriefFiles(
    task: Task,
    agents: readonly AgentFrontmatter[],
    orgName: string | undefined,
  ): Promise<void> {
    const fm = agents.find((a) => a.id === task.team[0]);
    const md = renderTaskMd(
      task,
      fm === undefined ? undefined : { id: fm.id, role: fm.role, model: fm.model, effort: fm.effort },
      orgName,
    );
    const pointer = renderPointer(task);
    await Promise.all([
      writeFile(join(task.folder, "TASK.md"), md),
      writeFile(join(task.folder, "AGENTS.md"), pointer),
      writeFile(join(task.folder, "CLAUDE.md"), pointer),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Start, stop, close, remove

  /** Creates the missing worktrees, marks the task running and starts its agent. Safe to repeat. */
  async start(id: string): Promise<Task> {
    const { store } = this.deps;
    const task = this.get(id);
    if (task.status === "done") throw new UserError(`Task ${id} is done.`, 409);
    const agent = task.team[0];
    if (agent === undefined)
      throw new UserError(
        `Task ${id} has no agent. Create one for its org in Studio, then create the task again.`,
        409,
      );

    for (const repo of task.repos) {
      if (repo.worktree !== undefined) continue;
      const path = join(task.folder, repo.project);
      try {
        const result = await createWorktree({
          source: repo.source,
          base: repo.base,
          branch: repo.branch,
          path,
          ...(this.deps.reloadKeys ? { reloadKeys: this.deps.reloadKeys } : {}),
        });
        store.tasks.setWorktree(id, repo.project, path, result.createdBranch);
        for (const w of result.warnings) this.warn(id, `${repo.project}: ${w}`);
      } catch (err) {
        if (err instanceof WorktreeProblem) throw new UserError(`${repo.project}: ${err.message}`, 409);
        throw new UserError(`${repo.project}: ${err instanceof Error ? err.message : String(err)}`, 409);
      }
    }
    store.tasks.setStatus(id, "running", undefined, this.now().toISOString());
    const started = this.get(id);
    this.deps.room.publishTask(started);
    this.deps.runs.startTask(started, agent);
    return started;
  }

  /** Cancels every turn, closes the sessions, and pauses a running task with reason owner. */
  async stop(id: string): Promise<Task> {
    const task = this.get(id);
    await this.deps.runs.stop(id);
    if (task.status === "running" || task.status === "paused") {
      this.deps.store.tasks.setStatus(id, "paused", "owner", this.now().toISOString());
    }
    const stopped = this.get(id);
    this.deps.room.publishTask(stopped);
    return stopped;
  }

  async close(id: string): Promise<Task> {
    const task = this.get(id);
    if (task.status === "done") return task;
    await this.deps.runs.stop(id);
    this.deps.store.tasks.setStatus(id, "done", undefined, this.now().toISOString());
    const closed = this.get(id);
    this.deps.room.publishTask(closed);
    return closed;
  }

  async remove(id: string, force: boolean): Promise<void> {
    const task = this.get(id);
    const trees = task.repos.flatMap((r) => (r.worktree === undefined ? [] : [r.worktree]));
    const dirty = await dirtyWorktrees(trees);
    if (dirty.length > 0 && !force) {
      throw new UserError(
        `Uncommitted changes in ${dirty.map((d) => d.path).join(", ")}. Commit or discard them, or remove with force.`,
        409,
        dirty.flatMap((d) => d.changes.slice(0, 5).map((c) => `${basename(d.path)}: ${c}`)),
      );
    }
    await this.deps.runs.stop(id);
    for (const repo of task.repos) {
      if (repo.worktree !== undefined) await removeWorktree(repo.source, repo.worktree, force);
    }
    // The folder is only ever `<tasks_dir>/<task id>`; refuse to delete anything else.
    if (basename(task.folder) === id && task.folder.includes(sep) && task.folder !== sep) {
      await rm(task.folder, { recursive: true, force: true });
    }
    this.deps.store.tasks.remove(id);
    this.deps.runs.forget(id);
  }

  // ---------------------------------------------------------------------------
  // Room

  async send(input: {
    task: string;
    text: string;
    attachments: string[];
    mode: "queue" | "interrupt";
    agent?: string | undefined;
  }): Promise<RoomItem> {
    const task = this.get(input.task);
    if (task.status === "done") throw new UserError(`Task ${task.id} is done.`, 409);
    if (input.text.trim() === "" && input.attachments.length === 0)
      throw new UserError("Write a message or attach a file.");
    const agent = this.agentFor(task, input.text, input.agent);
    await this.deps.uploads.assertAll(input.attachments);
    const attachments: Attachment[] = [];
    for (const upload of input.attachments) {
      attachments.push(await this.deps.uploads.take(upload, join(task.folder, "attachments")));
    }
    if (attachments.length > 0) {
      this.deps.store.tasks.addAttachments(task.id, attachments);
      this.deps.room.publishTask(this.get(task.id));
    }
    // A task that was never started, or was stopped, starts with the first message.
    let current = task;
    if (task.status !== "running") current = await this.start(task.id);
    const item = await this.deps.runs.send(current, agent, {
      text: input.text,
      attachments,
      mode: input.mode,
    });
    this.deps.store.tasks.touch(task.id, this.now().toISOString());
    this.deps.events.emit(["tasks"]);
    return item;
  }

  private agentFor(task: Task, text: string, requested: string | undefined): string {
    const first = task.team[0];
    if (requested !== undefined) {
      if (!task.team.includes(requested)) throw new UserError(`@${requested} is not on this task.`);
      return requested;
    }
    const mentioned = parseTaskText(text, { projects: [], agents: task.team.map((id) => ({ id })) })
      .mentions[0];
    const agent = mentioned ?? first;
    if (agent === undefined) throw new UserError(`Task ${task.id} has no agent.`, 409);
    return agent;
  }

  async cancel(id: string, agent: string | undefined): Promise<string[]> {
    this.get(id);
    return this.deps.runs.cancel(id, agent);
  }

  answerPermission(id: string, item: string, option: string): RoomItem {
    this.get(id);
    return this.deps.runs.answerPermission(id, item, option);
  }

  items(id: string, limit: number, beforeSeq: number | undefined) {
    this.get(id);
    this.deps.room.flush(id);
    return this.deps.store.room.page(id, limit, beforeSeq);
  }

  searchFiles(id: string, query: string): Promise<FileHit[]> {
    return this.files.search(this.get(id), query);
  }

  private warn(task: Task["id"], text: string): void {
    this.deps.room.post(task, `warn:${randomUUID()}`, { type: "system", level: "warn", text });
  }
}

async function branchExists(source: string, branch: string): Promise<boolean> {
  if (await localBranchExists(source, branch)) return true;
  const remote = await remoteOf(source).catch(() => undefined);
  return remote !== undefined && (await remoteBranchExists(source, remote, branch));
}
