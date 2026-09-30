import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, join, sep } from "node:path";
import {
  type AccountStatus,
  type AgentFrontmatter,
  type Attachment,
  type CoordinationMode,
  canWorkIn,
  LOCAL_TASK_PREFIX,
  MODE_LABELS,
  OWNER_HANDLE,
  type ParsedTask,
  parseMentions,
  parseTaskText,
  type RoomItem,
  type Task,
  type TaskId,
  type TaskKind,
  type TaskLink,
  type TaskRepo,
  type TaskSummary,
  type TeamOverride,
} from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { Decisions } from "../decisions/api.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { git, localBranchExists, remoteBranchExists, remoteOf, uncommitted } from "../git/git.ts";
import { localBranches, type MergeOutcome, mergeBranch } from "../git/merge.ts";
import {
  createWorktree,
  dirtyWorktrees,
  removeWorktree,
  restack,
  WorktreeProblem,
} from "../git/worktrees.ts";
import { orgKeys } from "../orgs/keys.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import { type FileHit, FileIndex } from "../room/files.ts";
import type { RoomService } from "../room/service.ts";
import { firstTurn, type Member } from "../rooms/coordinate.ts";
import { chooseTeam, teamOptions, teamQuestion } from "../rooms/teams.ts";
import { DEFAULT_IDENTITY } from "../runs/checkpoint.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { UploadStore } from "../uploads/store.ts";
import { pickDefaultAgent } from "./agents.ts";
import { type BriefAgent, branchName, renderPointer, renderTaskMd } from "./brief.ts";
import { fetchLinks, type LinkOptions } from "./links.ts";
import { describeCycle, findCycle, NO_RELATED, type Related, type RelatedTask } from "./relations.ts";

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
  /** Picks the default team of a new task (Phase 3). Absent: the rules' single agent. */
  decisions?: Decisions;
}

export interface CreateInput {
  text: string;
  kind?: TaskKind | undefined;
  agent?: string | undefined;
  /** The whole team, lead first. */
  team?: string[] | undefined;
  mode?: CoordinationMode | undefined;
  attachments: string[];
  start: boolean;
  /** Makes the new task a child of this one. */
  parent?: string | undefined;
  /** The new task waits for these. */
  dependsOn?: string[] | undefined;
  /** When those count as met. Default `merged`. */
  dependsWhen?: "merged" | "ready" | undefined;
}

/** Creating, starting, stopping and removing tasks, and the owner's messages to a task's agent. */
export class TaskService {
  private readonly files: FileIndex;
  private readonly now: () => Date;

  constructor(private readonly deps: TaskDeps) {
    this.files =
      deps.files ??
      new FileIndex(undefined, undefined, async () =>
        (await deps.projects.list()).map((p) => ({ id: p.id, path: p.path })),
      );
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
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    for (const other of [...dependsOn, ...(input.parent === undefined ? [] : [input.parent])]) {
      if (store.tasks.get(other) === undefined) throw new UserError(`Task ${other} does not exist.`, 404);
    }
    const parentTask = input.parent === undefined ? undefined : store.tasks.get(input.parent);
    // A child with no repos of its own belongs to its parent's org.
    const org = parsed.org ?? (parsed.repos.length === 0 ? parentTask?.org : undefined);
    if (org !== undefined && sections.orgs[org] === undefined) {
      throw new UserError(`Org "${org}" does not exist any more. Update the project first.`, 409);
    }

    const asked = this.askedTeam({ input, parsed, agents, org });
    const views = asked === undefined ? await this.deps.accounts.list() : [];
    const accountStatus = new Map(views.map((v) => [v.id, v.status]));
    const agent = asked?.[0] ?? pickDefaultAgent({ agents, org, boss: sections.boss, accountStatus });
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
    const picked =
      asked !== undefined
        ? { team: asked, mode: input.mode ?? "lead", line: undefined }
        : await this.pickTeam({
            id,
            kind,
            parsed,
            text: input.text,
            agents,
            org,
            boss: sections.boss,
            accountStatus,
            orgTeam: org === undefined ? undefined : sections.orgs[org]?.team,
            fallback: agent,
            mode: input.mode,
          });
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
        team: picked.team,
        mode: picked.mode,
        overrides: {},
        links: [
          ...(input.parent === undefined ? [] : [{ type: "parent" as const, task: input.parent }]),
          ...dependsOn.map((t) => ({
            type: "depends-on" as const,
            task: t,
            when: input.dependsWhen ?? "merged",
          })),
        ],
        attachments: [...files, ...links],
        createdAt: at,
        updatedAt: at,
      };
      await this.writeBriefFiles(task, agents, sections.orgs[org ?? ""]?.name, this.relatedOf(task));
      store.tasks.insert(task);
      store.tasks.setRoomState(id, firstTurn(task.mode, this.members(task, agents)).state);
      if (input.start) store.tasks.setStartWhenReady(id, true);
    } catch (err) {
      await rm(folder, { recursive: true, force: true });
      throw err;
    }

    for (const w of parsed.warnings) this.warn(id, w);
    if (picked.line !== undefined) this.note(id, picked.line);
    if (input.parent !== undefined) await this.linksChanged([input.parent]);
    let task = this.get(id);
    this.deps.room.publishTask(task);
    // A task that waits stays ready and starts by itself when its dependencies are met.
    const waiting = store.tasks.unmetDependencies(id);
    if (input.start && waiting.length > 0) {
      this.note(id, `Waiting on ${waiting.join(", ")}. It starts when they are done.`);
    } else if (input.start) {
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

  /**
   * The team the owner named: `team`, else `agent` and the @mentioned agents, lead first.
   * Undefined when nobody was named, so the default team is picked. Every agent must be able to
   * work in the org.
   */
  private askedTeam(args: {
    input: CreateInput;
    parsed: ParsedTask;
    agents: readonly AgentFrontmatter[];
    org: string | undefined;
  }): string[] | undefined {
    const { input, parsed, agents, org } = args;
    const named = input.team ?? [...(input.agent === undefined ? [] : [input.agent]), ...parsed.mentions];
    const team = [...new Set(named)];
    if (team.length === 0) return undefined;
    for (const id of team) {
      const found = agents.find((a) => a.id === id);
      if (found === undefined) throw new UserError(`Agent "${id}" does not exist or is invalid.`);
      if (!canWorkIn(found, org)) {
        throw new UserError(
          org === undefined
            ? `@${id} works in "${found.scope}", and this task has no org.`
            : `@${id} cannot work in "${org}".`,
        );
      }
    }
    return team;
  }

  /**
   * The default team of a new task (Phase 3): the org's `team` when it has one; else, when more
   * than one team is possible, the decision provider's pick with the decision recorded on the
   * task; else the rules' single agent. Chat tasks always get one agent.
   */
  private async pickTeam(args: {
    id: string;
    kind: TaskKind;
    parsed: ParsedTask;
    text: string;
    agents: readonly AgentFrontmatter[];
    org: string | undefined;
    boss: string | undefined;
    accountStatus: ReadonlyMap<string, AccountStatus>;
    orgTeam: readonly string[] | undefined;
    fallback: string | undefined;
    mode: CoordinationMode | undefined;
  }): Promise<{ team: string[]; mode: CoordinationMode; line: string | undefined }> {
    const solo = {
      team: args.fallback === undefined ? [] : [args.fallback],
      mode: args.mode ?? ("lead" as const),
    };
    if (args.kind === "chat") return { ...solo, line: undefined };
    const orgTeam = (args.orgTeam ?? []).filter((id) => {
      const a = args.agents.find((x) => x.id === id);
      return a !== undefined && canWorkIn(a, args.org);
    });
    if (orgTeam.length > 0) {
      return {
        team: orgTeam,
        mode: args.mode ?? "lead",
        line: `Team: the org's default team, ${orgTeam.map((a) => `@${a}`).join(", ")}.`,
      };
    }
    const options = teamOptions(args);
    if (options.length <= 1) return { ...solo, line: undefined };
    const result = await this.deps.decisions
      ?.decide(
        teamQuestion(
          {
            title: args.parsed.title,
            text: args.text,
            kind: args.kind,
            repos: args.parsed.repos.map((r) => r.project),
          },
          options,
        ),
        { use: "routing", task: args.id },
      )
      .catch(() => undefined);
    const pick = chooseTeam(options, result);
    if (pick === undefined) return { ...solo, line: undefined };
    return { team: pick.option.team, mode: args.mode ?? pick.option.mode, line: pick.line };
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
    related: Related = NO_RELATED,
  ): Promise<void> {
    const team = briefTeam(task, agents);
    const md = renderTaskMd(task, team[0], orgName, related, team);
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
    const waiting = store.tasks.unmetDependencies(id);
    if (waiting.length > 0) {
      // The owner wants it started: it starts by itself when the last dependency is met.
      store.tasks.setStartWhenReady(id, true);
      if (task.status === "inbox") {
        store.tasks.setStatus(id, "ready", undefined, this.now().toISOString());
        this.deps.room.publishTask(this.get(id));
      }
      throw new UserError(`Waiting on ${waiting.join(", ")}. It starts when they are done.`, 409);
    }
    if (task.team.length === 0)
      throw new UserError(
        `Task ${id} has no agent. Create one for its org in Studio, then create the task again.`,
        409,
      );

    for (const repo of task.repos) {
      if (repo.worktree !== undefined) continue;
      const path = join(task.folder, repo.project);
      // A `ready` dependency on the same project: this branch starts from its branch (5.4a).
      const stack = this.stackFor(task, repo.project);
      try {
        const result = await createWorktree({
          source: repo.source,
          base: stack?.branch ?? repo.base,
          branch: repo.branch,
          path,
          ...(stack === undefined ? {} : { localBase: true }),
          ...(this.deps.reloadKeys ? { reloadKeys: this.deps.reloadKeys } : {}),
        });
        store.tasks.setWorktree(id, repo.project, path, result.createdBranch);
        if (stack !== undefined && result.createdBranch) {
          store.tasks.setBase(id, repo.project, stack.branch);
          store.tasks.setStack(id, repo.project, { ...stack, commit: await headOf(path) });
          this.note(id, `${repo.project}: stacked on ${stack.task}'s branch ${stack.branch}.`);
        }
        for (const w of result.warnings) this.warn(id, `${repo.project}: ${w}`);
      } catch (err) {
        if (err instanceof WorktreeProblem) throw new UserError(`${repo.project}: ${err.message}`, 409);
        throw new UserError(`${repo.project}: ${err instanceof Error ? err.message : String(err)}`, 409);
      }
    }
    store.tasks.setStatus(id, "running", undefined, this.now().toISOString());
    store.tasks.setStartWhenReady(id, true);
    const started = this.get(id);
    this.deps.room.publishTask(started);
    // The mode says who goes first: the lead, the pipeline's first step, the loop's builder.
    const agents = await this.frontmatters();
    const first = firstTurn(started.mode, this.members(started, agents)).agents;
    first.forEach((agent, i) => {
      // The first agent gets the task's brief; others that start with it get their own, once.
      this.deps.runs.startTask(started, agent, { ownBrief: i > 0 });
    });
    return started;
  }

  /** The branch of a `ready` dependency that has the same project, for stacking (5.4a). */
  private stackFor(task: Task, project: string): { task: string; branch: string } | undefined {
    for (const l of task.links) {
      if (l.type !== "depends-on" || l.when !== "ready") continue;
      const dep = this.deps.store.tasks.get(l.task);
      const repo = dep?.repos.find((r) => r.project === project && r.worktree !== undefined);
      if (dep !== undefined && repo !== undefined) return { task: dep.id, branch: repo.branch };
    }
    return undefined;
  }

  private async frontmatters(): Promise<AgentFrontmatter[]> {
    return (await this.deps.agents.list()).flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
  }

  /** The team with each agent's role, lead first. An agent file that is gone counts as a Builder. */
  members(task: Task, agents: readonly AgentFrontmatter[]): Member[] {
    return task.team.map((id) => ({ id, role: agents.find((a) => a.id === id)?.role ?? "Builder" }));
  }

  /** Cancels every turn, closes the sessions, and pauses a running or reviewed task with reason owner. */
  async stop(id: string): Promise<Task> {
    const task = this.get(id);
    await this.deps.runs.stop(id);
    if (task.status === "running" || task.status === "paused" || task.status === "review") {
      this.deps.store.tasks.setStatus(id, "paused", "owner", this.now().toISOString());
    }
    const stopped = this.get(id);
    this.deps.room.publishTask(stopped);
    return stopped;
  }

  /** Changes the title and the description. Key, folder and branch stay; TASK.md is written again. */
  async update(input: {
    id: string;
    title?: string | undefined;
    brief?: string | undefined;
    agent?: string | undefined;
    mode?: CoordinationMode | undefined;
  }): Promise<Task> {
    const task = this.get(input.id);
    if (input.agent !== undefined && input.agent !== task.team[0]) await this.changeAgent(task, input.agent);
    if (input.mode !== undefined && input.mode !== task.mode) await this.changeMode(task, input.mode);
    const title = (input.title ?? task.title).trim();
    if (title === "") throw new UserError("The title cannot be empty.");
    const current = task.brief.trim().split(/\r?\n/);
    const body =
      input.brief ?? (current[0]?.startsWith(task.title) ? current.slice(1).join("\n") : task.brief).trim();
    const brief = body.trim() === "" ? title : `${title}\n\n${body.trim()}`;
    this.deps.store.tasks.setText(task.id, title, brief, this.now().toISOString());
    await this.refreshBriefs([task.id]);
    this.deps.room.publishTask(this.get(task.id));
    this.deps.events.emit(["tasks"]);
    return this.get(task.id);
  }

  /** A new coordination mode starts its own turn order; the loop guard's count stays. */
  private async changeMode(task: Task, mode: CoordinationMode): Promise<void> {
    const at = this.now().toISOString();
    this.deps.store.tasks.setMode(task.id, mode, at);
    const next = this.get(task.id);
    const { state } = firstTurn(mode, this.members(next, await this.frontmatters()));
    const agentTurns = this.deps.store.tasks.roomState(task.id).agentTurns;
    this.deps.store.tasks.setRoomState(task.id, { ...state, agentTurns });
    this.note(task.id, `Mode: ${MODE_LABELS[mode]}.`);
  }

  // ---------------------------------------------------------------------------
  // Team (5.3)

  /** Adds an agent that can work in the task's org. With `lead`, it goes first. */
  async addToTeam(id: string, agent: string, options: { lead?: boolean; by?: string } = {}): Promise<Task> {
    const task = this.get(id);
    const fm = await this.checkMember(task, agent);
    const rest = task.team.filter((a) => a !== agent);
    const team =
      options.lead === true ? [agent, ...rest] : task.team.includes(agent) ? task.team : [...rest, agent];
    if (team.join() === task.team.join()) return task;
    this.deps.store.tasks.setTeam(id, team, this.now().toISOString());
    this.note(
      id,
      `${options.by === undefined ? "Added" : `@${options.by} added`} @${agent} (${fm.role}) to the team${options.lead === true ? " as the lead" : ""}.`,
    );
    return this.teamChanged(id);
  }

  /** Takes an agent off the team and closes its session. The last agent and a working agent cannot go. */
  async removeFromTeam(id: string, agent: string): Promise<Task> {
    const task = this.get(id);
    if (!task.team.includes(agent)) throw new UserError(`@${agent} is not on ${id}.`, 404);
    if (task.team.length === 1)
      throw new UserError(`@${agent} is the only agent on ${id}. Swap it instead.`, 409);
    if (this.deps.runs.working(id).includes(agent))
      throw new UserError(`@${agent} is working on ${id}. Stop it first.`, 409);
    await this.deps.runs.remove(id, agent);
    const at = this.now().toISOString();
    this.deps.store.tasks.setTeam(
      id,
      task.team.filter((a) => a !== agent),
      at,
    );
    const { [agent]: _gone, ...overrides } = task.overrides;
    this.deps.store.tasks.setOverrides(id, overrides, at);
    this.note(id, `Removed @${agent} from the team.`);
    return this.teamChanged(id);
  }

  /** Puts another agent in an agent's place in the team. The old session closes. */
  async swapInTeam(id: string, agent: string, replacement: string): Promise<Task> {
    const task = this.get(id);
    if (!task.team.includes(agent)) throw new UserError(`@${agent} is not on ${id}.`, 404);
    if (task.team.includes(replacement)) throw new UserError(`@${replacement} is already on ${id}.`, 409);
    const fm = await this.checkMember(task, replacement);
    await this.deps.runs.remove(id, agent);
    const at = this.now().toISOString();
    this.deps.store.tasks.setTeam(
      id,
      task.team.map((a) => (a === agent ? replacement : a)),
      at,
    );
    const { [agent]: _gone, ...overrides } = task.overrides;
    this.deps.store.tasks.setOverrides(id, overrides, at);
    this.note(id, `@${replacement} (${fm.role}) took @${agent}'s place.`);
    return this.teamChanged(id);
  }

  /** The owner's model, effort and repos for one agent in this task. null clears one. */
  async setOverride(input: {
    task: string;
    agent: string;
    model?: string | null | undefined;
    effort?: string | null | undefined;
    repos?: string[] | null | undefined;
  }): Promise<Task> {
    const task = this.get(input.task);
    if (!task.team.includes(input.agent)) throw new UserError(`@${input.agent} is not on ${task.id}.`, 404);
    for (const repo of input.repos ?? []) {
      if (!task.repos.some((r) => r.project === repo)) throw new UserError(`${task.id} has no repo ${repo}.`);
    }
    const before: TeamOverride = task.overrides[input.agent] ?? {};
    const next: TeamOverride = { ...before };
    const apply = <K extends keyof TeamOverride>(key: K, value: TeamOverride[K] | null | undefined) => {
      if (value === undefined) return;
      if (value === null) delete next[key];
      else next[key] = value;
    };
    apply("model", input.model);
    apply("effort", input.effort);
    apply("repos", input.repos);
    const overrides = { ...task.overrides };
    if (Object.keys(next).length === 0) delete overrides[input.agent];
    else overrides[input.agent] = next;
    this.deps.store.tasks.setOverrides(task.id, overrides, this.now().toISOString());
    const live: { model?: string; effort?: string } = {
      ...(typeof input.model === "string" ? { model: input.model } : {}),
      ...(typeof input.effort === "string" ? { effort: input.effort } : {}),
    };
    const now = await this.deps.runs.applyOptions(task.id, input.agent, live).catch(() => false);
    const parts = [
      input.model === undefined ? undefined : `model ${input.model ?? "from its file"}`,
      input.effort === undefined ? undefined : `effort ${input.effort ?? "from its file"}`,
      input.repos === undefined
        ? undefined
        : input.repos === null
          ? "every repo"
          : input.repos.length === 0
            ? "no repos (reads only)"
            : `repos ${input.repos.join(", ")}`,
    ].filter((p) => p !== undefined);
    if (parts.length > 0) {
      const when = input.repos !== undefined || !now ? "" : " Applied to its session now.";
      this.note(task.id, `@${input.agent} in this task: ${parts.join(", ")}.${when}`);
    }
    return this.teamChanged(task.id);
  }

  private async checkMember(task: Task, agent: string): Promise<AgentFrontmatter> {
    const fm = (await this.frontmatters()).find((a) => a.id === agent);
    if (fm === undefined) throw new UserError(`Agent "${agent}" does not exist or is invalid.`, 404);
    if (!canWorkIn(fm, task.org)) {
      throw new UserError(
        `@${agent} cannot work in ${task.org === undefined ? "a task without an org" : `"${task.org}"`}. Change where it can work in Studio first.`,
        409,
      );
    }
    return fm;
  }

  private async teamChanged(id: string): Promise<Task> {
    await this.refreshBriefs([id]);
    const task = this.get(id);
    this.deps.room.publishTask(task);
    this.deps.events.emit(["tasks"]);
    return task;
  }

  /** The loop guard or the review round cap stopped the room: pause with reason owner and say why. */
  async pauseForOwner(id: string, text: string): Promise<void> {
    this.deps.room.post(id as TaskId, `error:${randomUUID()}`, { type: "system", level: "warn", text });
    await this.stop(id);
    this.deps.events.emit(["tasks"]);
  }

  /**
   * Splits a task into children (5.4a): each child is a full task under this one, and can wait
   * for earlier children. Children are created in order, so a failure leaves the ones before it.
   */
  async split(input: {
    task: string;
    children: {
      text: string;
      dependsOn: number[];
      when?: "merged" | "ready" | undefined;
      agent?: string | undefined;
    }[];
    start: boolean;
  }): Promise<Task[]> {
    const parent = this.get(input.task);
    if (parent.status === "done") throw new UserError(`${parent.id} is done.`, 409);
    input.children.forEach((c, i) => {
      for (const d of c.dependsOn) {
        if (d >= i)
          throw new UserError(`Child ${i + 1} can only wait for children before it (got ${d + 1}).`);
      }
    });
    const made: Task[] = [];
    for (const child of input.children) {
      const dependsOn = child.dependsOn.flatMap((d) => (made[d] === undefined ? [] : [made[d].id]));
      made.push(
        await this.create({
          text: child.text,
          agent: child.agent,
          attachments: [],
          start: input.start,
          parent: parent.id,
          dependsOn,
          dependsWhen: child.when,
        }),
      );
    }
    this.note(parent.id, `Split into ${made.map((t) => t.id).join(", ")}.`);
    return made.map((t) => this.get(t.id));
  }

  /**
   * A task's branches moved (a checkpoint): rebase the tasks stacked on them (5.4a). Each takes
   * the worktree's lock first, so no agent edits while it moves. A conflict leaves the worktree
   * as it was and says which files.
   */
  async restackOnto(id: string): Promise<void> {
    const { store } = this.deps;
    const dep = store.tasks.get(id);
    if (dep === undefined) return;
    for (const stacked of store.tasks.stackedOn(id)) {
      const task = store.tasks.get(stacked.task);
      const repo = task?.repos.find((r) => r.project === stacked.project);
      if (task === undefined || task.status === "done" || repo?.worktree === undefined) continue;
      const worktree = repo.worktree;
      const release = await this.deps.runs.locks.acquire([worktree], `restack:${task.id}`);
      try {
        const identity =
          (await this.deps.config.sections()).orgs[task.org ?? "private"]?.identity ?? DEFAULT_IDENTITY;
        const result = await restack({
          worktree,
          branch: repo.branch,
          onto: stacked.branch,
          from: stacked.commit,
          identity,
        });
        if (result.status === "rebased") {
          store.tasks.setStack(task.id, repo.project, {
            task: id,
            branch: stacked.branch,
            commit: result.commit,
          });
          this.note(task.id, `${repo.project}: rebased onto ${id}'s latest ${stacked.branch}.`);
          this.deps.room.publishTask(this.get(task.id));
        } else if (result.status === "skipped") {
          this.warn(
            task.id,
            `${repo.project}: ${id}'s branch moved, but the rebase waits: ${result.reason}.`,
          );
        } else if (result.status === "conflict") {
          this.warn(
            task.id,
            `${repo.project}: rebasing onto ${id}'s latest ${stacked.branch} conflicts in ${result.files.join(", ")}. The worktree was left as it was.`,
          );
        }
      } catch (err) {
        this.warn(
          task.id,
          `${repo.project}: could not rebase onto ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        release();
      }
    }
  }

  /** Gives the task (the lead's place) to another agent that can work in its org. Its old sessions close; the room says so. */
  private async changeAgent(task: Task, agent: string): Promise<void> {
    if (this.deps.runs.working(task.id).length > 0) {
      throw new UserError(`An agent is working on ${task.id}. Stop it first.`, 409);
    }
    const stored = await this.deps.agents.list();
    const found = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : [])).find((a) => a.id === agent);
    if (found === undefined) throw new UserError(`Agent "${agent}" does not exist or is invalid.`);
    if (!canWorkIn(found, task.org)) {
      throw new UserError(
        `@${agent} cannot work in ${task.org === undefined ? "a task without an org" : `"${task.org}"`}.`,
      );
    }
    await this.deps.runs.stop(task.id);
    // The new agent takes the lead's place; the rest of the team stays.
    const rest = task.team.slice(1).filter((a) => a !== agent);
    this.deps.store.tasks.setTeam(task.id, [agent, ...rest], this.now().toISOString());
    this.note(task.id, `The task moved from @${task.team[0] ?? "nobody"} to @${agent}.`);
  }

  async close(id: string): Promise<Task> {
    const task = this.get(id);
    if (task.status === "done") return task;
    await this.deps.runs.stop(id);
    this.deps.store.tasks.setStatus(id, "done", undefined, this.now().toISOString());
    const closed = this.get(id);
    this.deps.room.publishTask(closed);
    await this.statusChanged(id);
    return closed;
  }

  /**
   * Merges the task branch into a local branch (its base, or `into`) in each repo's checkout.
   * Refused while an agent of the task works or its worktree has uncommitted changes. Never pushes.
   */
  async merge(input: { id: string; into?: string | undefined; project?: string | undefined; done: boolean }) {
    const task = this.get(input.id);
    if (this.deps.runs.working(task.id).length > 0) {
      throw new UserError(
        `An agent of ${task.id} is working. Wait for its turn to end or stop it, then merge.`,
        409,
      );
    }
    const repos = task.repos.filter((r) => input.project === undefined || r.project === input.project);
    if (repos.length === 0) throw new UserError(`${task.id} has no repo to merge.`);
    const org = (await this.deps.config.sections()).orgs[task.org ?? "private"];
    const identity = org?.identity ?? DEFAULT_IDENTITY;
    const results: { project: string; into: string; ok: boolean; detail: string }[] = [];
    for (const repo of repos) {
      const into = input.into ?? repo.base;
      const dirty = repo.worktree === undefined ? [] : await uncommitted(repo.worktree).catch(() => []);
      if (dirty.some((l) => !l.startsWith("??"))) {
        results.push({
          project: repo.project,
          into,
          ok: false,
          detail: `The task's worktree has uncommitted changes. Ask the agent to commit them first.`,
        });
        continue;
      }
      const outcome = await mergeBranch({
        source: repo.source,
        branch: repo.branch,
        into,
        identity,
        message: `Merge ${task.id}: ${task.title}`,
        scratch: join(task.folder, ".merge", repo.project),
      }).catch((err: unknown): MergeOutcome => ({ ok: false, reason: errorMessage(err) }));
      results.push(
        outcome.ok
          ? {
              project: repo.project,
              into,
              ok: true,
              detail:
                outcome.how === "already merged"
                  ? `${repo.branch} is already in ${into}.`
                  : `Merged ${repo.branch} into ${into} (${outcome.how}). Not pushed.`,
            }
          : { project: repo.project, into, ok: false, detail: outcome.reason },
      );
    }
    for (const r of results) this.note(task.id, `${r.project}: ${r.detail}`);
    const clean = results.every((r) => r.ok);
    if (clean && input.done) return { results, task: await this.close(task.id) };
    return { results, task: this.get(task.id) };
  }

  /** Local branches of each repo of the task, for picking where to merge. */
  async branches(id: string) {
    const task = this.get(id);
    return Promise.all(
      task.repos.map(async (r) => ({
        project: r.project,
        base: r.base,
        branches: (await localBranches(r.source).catch(() => [r.base])).filter((b) => b !== r.branch),
      })),
    );
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
    const { store } = this.deps;
    const held = store.tasks.linksTo(id);
    store.tasks.remove(id);
    store.tasks.dropLinksTo(id);
    this.deps.runs.forget(id);
    await this.afterRemoval(task, held);
  }

  // ---------------------------------------------------------------------------
  // Links (5.4a)

  /** Makes `task` a child of `target`, or makes it wait for `target`. Refuses loops and a second parent. */
  async link(input: {
    task: string;
    type: "parent" | "depends-on";
    target: string;
    when?: "merged" | "ready" | undefined;
  }): Promise<Task> {
    const { store } = this.deps;
    const task = this.get(input.task);
    const target = this.get(input.target);
    if (task.id === target.id) throw new UserError(`${task.id} cannot be linked to itself.`, 409);
    const rows = store.tasks.allLinks();
    if (input.type === "parent") {
      const existing = rows.find((r) => r.task === task.id && r.type === "parent");
      if (existing !== undefined && existing.other !== target.id) {
        throw new UserError(`${task.id} is already part of ${existing.other}. Remove that link first.`, 409);
      }
    }
    const cycle = findCycle(rows, input.type, task.id, target.id);
    if (cycle !== undefined) throw new UserError(describeCycle(input.type, cycle), 409);
    store.tasks.putLink({
      task: task.id,
      type: input.type,
      other: target.id,
      ...(input.type === "depends-on" ? { when: input.when ?? "merged" } : {}),
    });
    await this.linksChanged([task.id, target.id]);
    return this.get(task.id);
  }

  async unlink(input: { task: string; type: TaskLink["type"]; target: string }): Promise<Task> {
    const { store } = this.deps;
    this.get(input.task);
    if (!store.tasks.removeLink(input.task, input.type, input.target)) {
      throw new UserError(`${input.task} has no ${input.type} link to ${input.target}.`, 404);
    }
    // Removing the last thing a task waited for, or the last unfinished child, can release it.
    await this.linksChanged([input.task, input.target]);
    if (input.type === "depends-on") {
      await this.startIfReady(input.task, `nothing is left to wait for`);
    } else if (input.type === "parent") {
      await this.finishParentIfDone(input.target);
    }
    return this.get(input.task);
  }

  /**
   * Call after a task's status changed by any path. Starts the tasks that were waiting on it
   * and are now free, closes a parent whose children are all done, and refreshes TASK.md of
   * the tasks that mention it. The run manager calls this when a task reaches review.
   */
  async statusChanged(id: string): Promise<void> {
    const { store } = this.deps;
    const task = store.tasks.get(id);
    if (task === undefined) return;
    const held = store.tasks.linksTo(id);
    const parent = task.links.find((l) => l.type === "parent")?.task;
    const what = task.status === "done" ? "done" : "ready for review";
    for (const l of held) {
      if (l.type === "depends-on") await this.startIfReady(l.task, `${id} is ${what}`);
    }
    if (parent !== undefined) await this.finishParentIfDone(parent);
    await this.refreshBriefs([id, ...held.map((l) => l.task), ...(parent === undefined ? [] : [parent])]);
    this.deps.events.emit(["tasks"]);
  }

  private async startIfReady(id: string, why: string): Promise<void> {
    const { store } = this.deps;
    const task = store.tasks.get(id);
    if (task === undefined || !store.tasks.startWhenReady(id)) return;
    if (task.status !== "inbox" && task.status !== "ready") return;
    if (store.tasks.unmetDependencies(id).length > 0) return;
    this.note(id, `Started: ${why}.`);
    try {
      await this.start(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.room.post(id, `error:${randomUUID()}`, {
        type: "system",
        level: "error",
        text: `Could not start: ${message}`,
      });
    }
  }

  private async finishParentIfDone(parent: string): Promise<void> {
    const { store } = this.deps;
    const task = store.tasks.get(parent);
    if (task === undefined || task.status === "done" || !store.tasks.childrenDone(parent)) return;
    this.note(parent, "Every subtask is done. Task closed.");
    await this.close(parent);
  }

  /** A task other tasks pointed at is gone: children become top-level, waiting tasks ask the owner. */
  private async afterRemoval(
    removed: Task,
    held: readonly { task: string; type: TaskLink["type"] }[],
  ): Promise<void> {
    const { store } = this.deps;
    const touched: string[] = [];
    for (const l of held) {
      touched.push(l.task);
      if (l.type !== "depends-on") continue;
      const waiting = store.tasks.get(l.task);
      if (waiting === undefined) continue;
      if (waiting.status !== "inbox" && waiting.status !== "ready" && waiting.status !== "paused") continue;
      store.tasks.setStartWhenReady(waiting.id, false);
      store.tasks.setStatus(waiting.id, "paused", "owner", this.now().toISOString());
      this.deps.room.post(waiting.id, `error:${randomUUID()}`, {
        type: "system",
        level: "error",
        text: `${removed.id} was removed, and this task was waiting for it. Start it anyway, or link it to another task?`,
      });
      this.deps.room.publishTask(this.get(waiting.id));
    }
    const parent = removed.links.find((l) => l.type === "parent")?.task;
    if (parent !== undefined) {
      touched.push(parent);
      await this.finishParentIfDone(parent);
    }
    await this.refreshBriefs(touched);
    this.deps.events.emit(["tasks"]);
  }

  private async linksChanged(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const task = this.deps.store.tasks.get(id);
      if (task !== undefined) this.deps.room.publishTask(task);
    }
    await this.refreshBriefs(ids);
    this.deps.events.emit(["tasks"]);
  }

  /** Rewrites TASK.md of each task so its Related tasks section is current. */
  private async refreshBriefs(ids: readonly string[]): Promise<void> {
    const sections = await this.deps.config.sections();
    const stored = await this.deps.agents.list();
    const agents = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    for (const id of new Set(ids)) {
      const task = this.deps.store.tasks.get(id);
      if (task === undefined) continue;
      const team = briefTeam(task, agents);
      const md = renderTaskMd(task, team[0], sections.orgs[task.org ?? ""]?.name, this.relatedOf(task), team);
      // The folder can be gone by hand; the links still stand.
      await writeFile(join(task.folder, "TASK.md"), md).catch(() => undefined);
    }
  }

  private relatedOf(task: Task): Related {
    const { store } = this.deps;
    const rel = (id: string): RelatedTask | undefined => {
      const t = store.tasks.get(id);
      return t === undefined
        ? undefined
        : { id, title: t.title, status: t.status, branches: t.repos.map((r) => r.branch) };
    };
    const related: Related = { depends: [], children: [] };
    for (const l of task.links) {
      const other = rel(l.task);
      if (other === undefined) continue;
      if (l.type === "parent") related.parent = other;
      else if (l.type === "depends-on") related.depends.push({ ...other, when: l.when ?? "merged" });
    }
    for (const l of store.tasks.linksTo(task.id)) {
      if (l.type !== "parent") continue;
      const child = rel(l.task);
      if (child !== undefined) related.children.push(child);
    }
    return related;
  }

  private note(task: TaskId, text: string): void {
    this.deps.room.post(task, `info:${randomUUID()}`, { type: "system", level: "info", text });
  }

  // ---------------------------------------------------------------------------
  // Room

  /**
   * An agent finished its turn with nothing queued. When no agent in the task is still working,
   * the task moves to review: the owner replies (back to running) or marks it done.
   */
  async agentsIdle(id: string): Promise<void> {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || task.status !== "running") return;
    // The boss chat is an ongoing conversation, never a piece of work to review.
    if (isBossChat(task)) return;
    if (this.deps.runs.working(id).length > 0) return;
    this.deps.store.tasks.setStatus(id, "review", undefined, this.now().toISOString());
    this.note(task.id, "Ready for your review. Reply to continue, or mark it done.");
    this.deps.room.publishTask(this.get(id));
    this.deps.events.emit(["tasks"]);
    await this.statusChanged(id);
  }

  /** An agent paused on its own (offline, or an error it cannot get past): a running task pauses with it. */
  async pausedByRuns(id: string, reason: "offline" | "error"): Promise<void> {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || (task.status !== "running" && task.status !== "review")) return;
    this.deps.store.tasks.setStatus(id, "paused", reason, this.now().toISOString());
    this.deps.room.publishTask(this.get(id));
    await this.statusChanged(id);
  }

  /** A paused agent resumes by itself: a task majhi paused runs again. Tasks the owner stopped stay stopped. */
  async resumedByRuns(id: string): Promise<void> {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || task.status !== "paused" || task.pausedReason === "owner") return;
    this.deps.store.tasks.setStatus(id, "running", undefined, this.now().toISOString());
    this.deps.room.publishTask(this.get(id));
    await this.statusChanged(id);
  }

  /** "Fresh session" on an agent in the room (5.13). */
  fresh(id: string, agent: string | undefined): Promise<RoomItem> {
    const task = this.get(id);
    const target = agent ?? task.team[0];
    if (target === undefined) throw new UserError(`Task ${id} has no agent.`, 409);
    if (!task.team.includes(target)) throw new UserError(`@${target} is not on this task.`);
    return this.deps.runs.fresh(task, target);
  }

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
    const targets = await this.ownerTargets(task, input.text, input.agent);
    const agent = targets[0];
    if (agent === undefined) throw new UserError(`Task ${task.id} has no agent.`, 409);
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
    // The owner spoke: the loop guard counts agent turns from here.
    const state = this.deps.store.tasks.roomState(task.id);
    if (state.agentTurns > 0) this.deps.store.tasks.setRoomState(task.id, { ...state, agentTurns: 0 });
    const item = await this.deps.runs.send(current, agent, {
      text: input.text,
      attachments,
      mode: input.mode,
      also: targets.slice(1),
    });
    this.deps.store.tasks.touch(task.id, this.now().toISOString());
    this.deps.events.emit(["tasks"]);
    return item;
  }

  /**
   * Who an owner message goes to (5.3): the requested agent; else every @mentioned agent, adding
   * the ones not on the team when they may work in its org; else the lead.
   */
  private async ownerTargets(task: Task, text: string, requested: string | undefined): Promise<string[]> {
    if (requested !== undefined) {
      if (!task.team.includes(requested)) throw new UserError(`@${requested} is not on this task.`);
      return [requested];
    }
    const agents = await this.frontmatters();
    const mentioned = parseMentions(
      text,
      agents.map((a) => a.id),
    ).filter((m) => m !== OWNER_HANDLE);
    for (const m of mentioned) {
      if (!task.team.includes(m)) await this.addToTeam(task.id, m);
    }
    if (mentioned.length > 0) return mentioned;
    const lead = task.team[0];
    return lead === undefined ? [] : [lead];
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

function briefTeam(task: Task, agents: readonly AgentFrontmatter[]): BriefAgent[] {
  return task.team.flatMap((id) => {
    const fm = agents.find((a) => a.id === id);
    if (fm === undefined) return [];
    const o: TeamOverride | undefined = task.overrides[id];
    return [
      {
        id: fm.id,
        role: fm.role,
        model: o?.model ?? fm.model,
        effort: o?.effort ?? fm.effort,
        perms: fm.perms,
        ...(o?.repos === undefined ? {} : { repos: o.repos }),
      },
    ];
  });
}

async function headOf(worktree: string): Promise<string> {
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

async function branchExists(source: string, branch: string): Promise<boolean> {
  if (await localBranchExists(source, branch)) return true;
  const remote = await remoteOf(source).catch(() => undefined);
  return remote !== undefined && (await remoteBranchExists(source, remote, branch));
}
