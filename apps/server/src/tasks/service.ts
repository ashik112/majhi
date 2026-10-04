import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import {
  type AccountStatus,
  type AgentFrontmatter,
  type Attachment,
  AUTO,
  type CoordinationMode,
  canWorkIn,
  chatTitleFrom,
  connectionType,
  DEFAULT_CHAT_TITLES,
  isOwnerChat,
  LOCAL_TASK_PREFIX,
  MODE_LABELS,
  OWNER_HANDLE,
  type ParsedTask,
  type PendingNotice,
  type PendingShip,
  type PlanMember,
  type ProcessInfo,
  parseMentions,
  parsePathMentions,
  parseTaskText,
  type ReadMount,
  type RoomItem,
  type RoomSearchHit,
  type ShipOption,
  type ShipOptions,
  shipWords,
  type Task,
  type TaskId,
  type TaskKind,
  type TaskLink,
  type TaskPriority,
  type TaskRepo,
  type TaskSummary,
  type TeamOverride,
  type TeamPlan,
  waitsForOwner,
} from "@majhi/shared";
import type { AccountService } from "../accounts/service.ts";
import { isBossChat } from "../admin/boss.ts";
import type { AgentStore } from "../agents/store.ts";
import { logShip } from "../audit.ts";
import type { ConfigService } from "../config/service.ts";
import { runConnections } from "../connections/access.ts";
import { useLine } from "../connections/plan.ts";
import type { Decisions } from "../decisions/api.ts";
import { errorMessage, UserError } from "../errors.ts";
import type { EventHub } from "../events/hub.ts";
import { writeFileAtomic } from "../fs.ts";
import { repoDiff } from "../git/diff.ts";
import { git, localBranchExists, remoteBranchExists, remoteOf, uncommitted } from "../git/git.ts";
import {
  localBranches,
  type MergeMethod,
  type MergeOutcome,
  mergeBlocker,
  mergeBranch,
  remoteBranches,
} from "../git/merge.ts";
import { commitsSinceStart } from "../git/since-start.ts";
import {
  baseExists,
  createWorktree,
  dirtyWorktrees,
  removeWorktree,
  restack,
  WorktreeProblem,
} from "../git/worktrees.ts";
import type { MemoryService } from "../memory/service.ts";
import type { TaskScopes } from "../memory/wiring.ts";
import { mrRemoteName } from "../mrs/remote.ts";
import { pendingNotices, type Subject } from "../notify/attention.ts";
import { orgKeys } from "../orgs/keys.ts";
import type { ProcessManager } from "../processes/manager.ts";
import { endItemId, supersededBy } from "../processes/notices.ts";
import type { ProjectInfo, ProjectService } from "../projects/service.ts";
import { type FileHit, FileIndex } from "../room/files.ts";
import type { RoomService } from "../room/service.ts";
import { firstTurn, type Member } from "../rooms/coordinate.ts";
import { chooseTeam, teamOptions, teamQuestion } from "../rooms/teams.ts";
import { attributionOf } from "../runs/attribution.ts";
import { commitAll, commitBy, DEFAULT_IDENTITY } from "../runs/checkpoint.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import type { TerminalManager } from "../terminal/manager.ts";
import { taskTerminalKey } from "../terminal/task-terminal.ts";
import {
  type AttachSource,
  openChecked,
  planAttachments,
  resolveTaskFile,
  takePlanned,
} from "../uploads/attach.ts";
import type { UploadStore } from "../uploads/store.ts";
import type { UsageRepo } from "../usage/repo.ts";
import { pickDefaultAgent } from "./agents.ts";
import { type BriefAgent, type BriefConnection, branchName, renderPointer, renderTaskMd } from "./brief.ts";
import { OwnerCards } from "./cards.ts";
import { deleteAfterShip, deleteRefusal } from "./delete-after.ts";
import { handoverNote } from "./handover.ts";
import { fetchLinks, type LinkOptions } from "./links.ts";
import { Orchestrator } from "./orchestrator.ts";
import { type PickedRepo, withPickedRepos } from "./picked-repos.ts";
import { TaskPlanner } from "./planner.ts";
import type { Footprint } from "./planning.ts";
import { TaskPlans } from "./plans.ts";
import { blockedPaths, checkReadMount, projectsFor, type ReadPolicy, ReadRefused } from "./read-mounts.ts";
import {
  childrenWaitOnParent,
  describeCycle,
  findCycle,
  NO_RELATED,
  type Related,
  type RelatedTask,
} from "./relations.ts";
import {
  heldResult,
  holdProtected,
  type ShipPlan,
  type ShipTargets,
  shipPlan,
  skippedResult,
  targetRefusal,
} from "./ship-plan.ts";
import { unshippedText, unshippedWork } from "./shipped.ts";
import { type TeamFacts, wakeFacts } from "./team-facts.ts";
import { TeamFactsSource } from "./team-facts-source.ts";

export interface TaskDeps {
  /** The owner resumed a task that a budget paused: budget alerts so far no longer hold it. */
  onOwnerResumedLimit?: (task: string) => void;
  /** The owner resumed a paused task by hand: autonomous mode's pause no longer holds it (PRV-74). */
  onOwnerResumed?: (task: string) => void;
  /** The owner answered a permission prompt: what they picked, so a decision about it can be labeled (SPEC 5.12). */
  onOwnerPermission?: (task: string, item: RoomItem) => void;
  /** Files no agent may read, like the secrets key. majhi's home and `~/.ssh` are always protected. */
  protectedPaths?: string[];
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
  /** Background processes (5.15): stopped with the task, and they keep it running while agents wait. */
  processes?: ProcessManager;
  /**
   * Previews and services (PRV-53): they stop while the task does not run (review, paused) and
   * start again when it runs. Their volumes go when it is done or removed.
   */
  containers?: {
    taskPaused(id: string, options?: { keepUnsaved?: boolean }): Promise<{ kept: string[] }>;
    taskRunning(id: string): Promise<{ started: string[]; failed: string[] }>;
    taskEnded(id: string): Promise<void>;
  };
  /** The task's terminal (5.15) is killed when the task is stopped, closed or removed. */
  terminals?: TerminalManager;
  /** Facts recalled into TASK.md when a task starts (Phase 5). */
  memory?: MemoryService;
  memoryScopes?: TaskScopes;
  /** An agent finished a turn in a chat: names it, and so on. Never awaited. */
  onChatTurn?: (id: string) => void;
  /** A task became done (Phase 5): the Housekeeper reads its room, and a promotion that did not merge is released. */
  onDone?: (task: Task) => void | Promise<void>;
  /** A task is about to be removed (Phase 5): its worktrees and branch are still there. */
  onRemoving?: (task: Task) => Promise<void>;
  /** Throws when the task may not be closed or removed now: autonomous mode's chat while the mode is not off. */
  guardRemoval?: (task: Task, action: "close" | "remove") => void;
  /** The agents finished and the task reached review: a ship waiting for the lead may run now. */
  onReview?: (id: string) => Promise<void>;
  /** majhi merged a task's branch into `into` of `project`. Never awaited (background e2e, PRV-72). */
  onMerged?: (merge: { task: string; project: string; into: string }) => void | Promise<void>;
  /** Token totals per agent, for what each plan version cost. */
  usage?: UsageRepo;
  /** Resolves when every queued usage row is written. */
  flushUsage?: () => Promise<void>;
}

export interface CreateInput {
  text: string;
  /** The repos the task changes, picked on purpose. Names in the text attach nothing. */
  repos?: readonly PickedRepo[] | undefined;
  /** The owner asked: only then may a protected project join, and agents write in it. */
  byOwner?: boolean | undefined;
  /** A separate short title: it becomes the first line, and `text` the description. */
  title?: string | undefined;
  kind?: TaskKind | undefined;
  /** An investigation: the named repos are mounted read-only, with no branch, worktree or Ship. */
  readOnly?: boolean | undefined;
  agent?: string | undefined;
  /** The org of a task with no project, like a chat with an org's agent. Projects in the text win. */
  org?: string | undefined;
  /** The whole team, lead first. */
  team?: string[] | undefined;
  mode?: CoordinationMode | undefined;
  /** Upload ids, or paths of files in the `from` task's folder. */
  attachments: string[];
  /** The task of the agent that asked. Only it lets `attachments` hold paths. */
  from?: string | undefined;
  start: boolean;
  /** Makes the new task a child of this one. */
  parent?: string | undefined;
  /** The new task waits for these. */
  dependsOn?: string[] | undefined;
  /** Makes the new task a fix task of this one: a `follow-up` link to it. */
  followUpOf?: string | undefined;
  /** When those count as met. Default `merged`. */
  dependsWhen?: "merged" | "ready" | undefined;
  /** Connection ids its root agents get beyond the task's org's. */
  connections?: string[] | undefined;
}

/** Creating, starting, stopping and removing tasks, and the owner's messages to a task's agent. */
export class TaskService {
  private readonly files: FileIndex;
  private readonly now: () => Date;
  /** `wait` processes the room was told the task waits for, so it is said once. */
  private readonly waitNoted = new Set<string>();
  /** Lead orchestration: the check before a waiting task starts, and the lead's side of a parent. */
  private readonly orchestrator: Orchestrator;
  private readonly planner: TaskPlanner;
  private readonly teamFacts: TeamFactsSource;
  private readonly plans: TaskPlans;
  /** The facts block each (task, agent) got last, so a wake prompt only repeats them when they changed. */
  private readonly chatRecallSeen = new Map<string, string>();
  private readonly wakeSeen = new Map<string, string>();
  /** The last facts read per task, for the team it had then: a status change rewrites TASK.md without new git diffs. */
  private readonly lastFacts = new Map<string, { team: string; facts: TeamFacts }>();
  /** The review and paused cards majhi posts in a task's room. */
  readonly cards: OwnerCards;

  constructor(private readonly deps: TaskDeps) {
    this.files =
      deps.files ??
      new FileIndex(undefined, undefined, async () =>
        (await deps.projects.list()).map((p) => ({ id: p.id, path: p.path })),
      );
    this.now = deps.now ?? (() => new Date());
    this.cards = new OwnerCards({
      store: deps.store,
      room: deps.room,
      now: this.now,
      captain: () => deps.config.knownBoss(),
    });
    this.planner = new TaskPlanner({
      store: deps.store,
      agents: deps.agents,
      accounts: deps.accounts,
      now: this.now,
    });
    this.teamFacts = new TeamFactsSource({
      store: deps.store,
      agents: deps.agents,
      accounts: deps.accounts,
      config: deps.config,
      planner: this.planner,
      now: this.now,
    });
    this.plans = new TaskPlans({
      store: deps.store,
      room: deps.room,
      usage: deps.usage,
      flushUsage: deps.flushUsage,
      team: (task) => this.planTeam(task),
      now: this.now,
    });
    this.orchestrator = new Orchestrator({
      store: deps.store,
      room: deps.room,
      runs: deps.runs,
      planner: this.planner,
      host: {
        start: (id) => this.start(id),
        swap: (id, agent, replacement) => this.swapInTeam(id, agent, replacement),
        linksChanged: (ids) => this.linksChanged(ids),
      },
    });
  }

  list(includeDone: boolean): TaskSummary[] {
    const rows = this.deps.store.tasks.list(includeDone);
    const waiting = this.deps.store.room.tasksWaitingOnOwner();
    return rows.map((t) => ({
      ...t,
      working: this.deps.runs.working(t.id),
      ...(t.status !== "done" && waiting.has(t.id) ? { asking: true } : {}),
    }));
  }

  /** What waits for the owner in open tasks and chats, oldest first (`notify.pending`). */
  pendingForOwner(): PendingNotice[] {
    const open = new Map<string, Subject | undefined>();
    const subject = (id: string): Subject | undefined => {
      if (!open.has(id)) {
        const task = this.deps.store.tasks.get(id);
        open.set(
          id,
          task === undefined || task.status === "done"
            ? undefined
            : { id: task.id, title: task.title, chat: isOwnerChat(task) },
        );
      }
      return open.get(id);
    };
    return pendingNotices(this.deps.store.room.waitingOnOwner(), subject);
  }

  /** What the task has changed per project, or names in its description (the repo rule reads it). */
  footprints(task: Task): Promise<Footprint[]> {
    return this.planner.footprints(task);
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

  async create(given: CreateInput): Promise<Task> {
    // A separate title becomes the first line, so the parser and the brief see one text as usual.
    const input = given.title === undefined ? given : { ...given, text: `${given.title}\n\n${given.text}` };
    const { store, config, uploads } = this.deps;
    const loaded = await config.load();
    if (loaded.state.status !== "loaded") throw new UserError("Pick workspace roots first.", 409);
    const tasksDir = loaded.state.config.tasksDir;
    const sections = await config.sections();
    const projects = await this.deps.projects.infos();
    const stored = await this.deps.agents.list();
    const agents = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));

    // Only the repos picked on purpose join the task. Names in the text attach nothing.
    const picks = withPickedRepos(
      input.text,
      parseTaskText(input.text, {
        projects: projects.map((p) => ({
          id: p.id,
          org: p.org,
          aliases: p.aliases,
        })),
        agents: agents.map((a) => ({ id: a.id })),
      }),
      input.repos,
      projects,
      input.byOwner === true,
    );
    const parsed = picks.parsed;
    const orgs = new Set(parsed.repos.map((r) => projects.find((p) => p.id === r.project)?.org));
    if (orgs.size > 1) {
      throw new UserError(
        `${parsed.warnings.find((w) => w.startsWith("Repos from")) ?? "Repos from more than one org"}. Make one task per org.`,
      );
    }
    // An investigation reads the repos it names. It gets no branch, no worktree, no Changes and no Ship.
    const kind = input.kind ?? (input.readOnly === true && parsed.kind === "code" ? "ops" : parsed.kind);
    const investigation = input.readOnly === true || kind === "ops";
    // Every repo listed was protected and left out: nothing is left to make the task about.
    if (!investigation && parsed.repos.length === 0 && picks.refused.length > 0) {
      throw new UserError(
        `${picks.refused.join(", ")} ${picks.refused.length === 1 ? "is" : "are"} protected: only the owner can add ${picks.refused.length === 1 ? "it" : "them"} to a task.`,
        409,
      );
    }
    if (kind === "code" && parsed.repos.length === 0) {
      throw new UserError("A code task needs a project. Pick the repos it changes, or change the kind.");
    }
    const dependsOn = [...new Set(input.dependsOn ?? [])];
    const others = [
      ...dependsOn,
      ...[input.parent, input.followUpOf].flatMap((t) => (t === undefined ? [] : [t])),
    ];
    for (const other of others) {
      if (store.tasks.get(other) === undefined) throw new UserError(`Task ${other} does not exist.`, 404);
    }
    const parentTask = input.parent === undefined ? undefined : store.tasks.get(input.parent);
    const followedTask = input.followUpOf === undefined ? undefined : store.tasks.get(input.followUpOf);
    // A child with no repos of its own belongs to its parent's org, a fix task to its ops task's.
    const org =
      parsed.org ??
      (parsed.repos.length === 0 ? (input.org ?? parentTask?.org ?? followedTask?.org) : undefined);
    if (org !== undefined && sections.orgs[org] === undefined) {
      throw new UserError(`Org "${org}" does not exist any more. Update the project first.`, 409);
    }
    const connections = [...new Set(input.connections ?? [])];
    for (const id of connections) {
      if (!Object.values(sections.orgs).some((o) => o.connections?.[id] !== undefined)) {
        throw new UserError(`There is no connection ${id}.`, 404);
      }
    }

    const asked = this.askedTeam({ input, parsed, agents, org });
    const views = asked === undefined ? await this.deps.accounts.list() : [];
    const accountStatus = new Map(views.map((v) => [v.id, v.status]));
    const agent = asked?.[0] ?? pickDefaultAgent({ agents, org, boss: sections.boss, accountStatus });
    if (agent === undefined && input.start) {
      throw new UserError(
        org === undefined
          ? "No agent can run a task without an org. Create the captain in Studio."
          : `No agent can work in "${org}". Create one in Studio.`,
        409,
      );
    }
    const planned = await planAttachments(uploads, input.attachments, this.attachSource(input.from), { org });

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
    const repoPlan = investigation
      ? { repos: [], warnings: [] }
      : await this.planRepos(id, parsed, projects, picks.bases);
    const repos = repoPlan.repos.map((r) => (picks.writes.has(r.project) ? { ...r, writes: true } : r));
    const at = this.now().toISOString();

    await mkdir(tasksDir, { recursive: true });
    try {
      await mkdir(folder);
    } catch {
      throw new UserError(`${folder} already exists. Move it away and try again.`, 409);
    }
    try {
      const attachmentsDir = join(folder, "attachments");
      const files = await takePlanned(uploads, planned, attachmentsDir);
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
        ...(investigation ? { readMounts: this.investigationMounts(parsed, projects, at) } : {}),
        ...(connections.length === 0 ? {} : { connections }),
        team: picked.team,
        mode: picked.mode,
        overrides: {},
        links: [
          ...(input.parent === undefined ? [] : [{ type: "parent" as const, task: input.parent }]),
          ...(input.followUpOf === undefined ? [] : [{ type: "follow-up" as const, task: input.followUpOf }]),
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

    for (const w of [...parsed.warnings, ...repoPlan.warnings]) this.warn(id, w);
    if (picks.refused.length > 0) {
      this.warn(
        id,
        `Left out ${picks.refused.join(", ")}: ${picks.refused.length === 1 ? "it is" : "they are"} protected, so only you can add ${picks.refused.length === 1 ? "it" : "them"} to a task. Agents can still read ${picks.refused.length === 1 ? "it" : "them"}.`,
      );
    }
    if (picks.mentioned.length > 0) {
      this.note(
        id,
        `Named in the text but not part of this task: ${picks.mentioned.join(", ")}. Agents can read ${picks.mentioned.length === 1 ? "it" : "them"}; nothing there gets a branch or ships.`,
      );
    }
    if (picked.line !== undefined) this.note(id, picked.line);
    const linked = [input.parent, input.followUpOf].flatMap((t) => (t === undefined ? [] : [t]));
    if (linked.length > 0) await this.linksChanged(linked);
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
  }): Promise<{
    team: string[];
    mode: CoordinationMode;
    line: string | undefined;
  }> {
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
    if (result !== undefined)
      this.deps.decisions?.outcome(result.id, {
        text: pick.line,
        fellBack: pick.decision === undefined,
        choices: options.map((o) => o.key),
      });
    return {
      team: pick.option.team,
      mode: args.mode ?? pick.option.mode,
      line: pick.line,
    };
  }

  /** The checkouts an investigation reads, read-only, for every agent of the task. */
  private investigationMounts(parsed: ParsedTask, projects: readonly ProjectInfo[], at: string): ReadMount[] {
    const mounts: ReadMount[] = [];
    for (const match of parsed.repos) {
      const project = projects.find((p) => p.id === match.project);
      if (project === undefined) continue;
      if (!project.exists) throw new UserError(`${project.path} is not a git repo the server can see.`, 409);
      mounts.push({ path: project.path, at });
    }
    return mounts;
  }

  /**
   * Folders the owner mentioned as `@/path` in a message to these agents: each one that passes the
   * read rules is mounted read-only for that agent from now on, the room gets a quiet line, and
   * the agent's session restarts to see it. A path that does not pass gets a line saying why.
   */
  private async grantMentionedReads(task: Task, agents: readonly string[], text: string): Promise<void> {
    const paths = parsePathMentions(text);
    if (paths.length === 0) return;
    const loaded = await this.deps.config.load();
    if (loaded.state.status !== "loaded") return;
    const { workspaces, tasksDir } = loaded.state.config;
    const projects = (await this.deps.projects.infos()).map((p) => ({
      path: p.path,
      org: p.org,
    }));
    const frontmatters = await this.frontmatters();
    const { majhiHome, hostHome } = this.deps.config.paths;
    const blocked = blockedPaths({
      majhiHome,
      hostHome,
      protectedPaths: this.deps.protectedPaths ?? [],
    });
    let mounts = this.get(task.id).readMounts ?? [];
    for (const agent of agents) {
      const scope = frontmatters.find((a) => a.id === agent)?.scope;
      if (scope === undefined) continue;
      const policy: ReadPolicy = {
        roots: workspaces,
        projects,
        scope,
        blocked,
        tasksDir,
      };
      let granted = false;
      for (const asked of paths) {
        try {
          const path = await checkReadMount(asked, policy);
          if (mounts.some((m) => m.path === path && (m.agent === undefined || m.agent === agent))) continue;
          mounts = [...mounts, { path, agent, at: this.now().toISOString() }];
          granted = true;
          this.note(task.id, `@${agent} can now read ${path} (read-only).`);
        } catch (err) {
          if (!(err instanceof ReadRefused)) throw err;
          this.note(task.id, `@${agent} cannot read ${asked}: ${err.message}`);
        }
      }
      if (!granted) continue;
      this.deps.store.tasks.setReadMounts(task.id, mounts, this.now().toISOString());
      this.deps.runs.remount(task.id, agent);
    }
  }

  private async planRepos(
    id: string,
    parsed: ParsedTask,
    projects: readonly ProjectInfo[],
    bases: ReadonlyMap<string, string> = new Map(),
  ): Promise<{ repos: TaskRepo[]; warnings: string[] }> {
    const repos: TaskRepo[] = [];
    const warnings: string[] = [];
    for (const match of parsed.repos) {
      const project = projects.find((p) => p.id === match.project);
      if (project === undefined) continue;
      if (!project.exists) throw new UserError(`${project.path} is not a git repo the server can see.`, 409);
      // The base comes from the creator's pick for this repo or the project, never from prose like
      // "move off staging". The working branch is always a new task branch, never one that exists:
      // an agent must not commit on the owner's own branches.
      const picked = bases.get(project.id);
      let base = picked ?? project.base;
      // A picked base the repo does not have falls back to the project's, said in the room.
      if (picked !== undefined && picked !== project.base && !(await baseExists(project.path, picked))) {
        base = project.base;
        warnings.push(
          `${project.id} has no branch ${picked}. Starting from ${project.base ?? "the project's base"} instead. To change it before the task starts, update its base.`,
        );
      }
      if (base === undefined)
        throw new UserError(`Project "${project.id}" has no base branch. Set one on the project.`);
      const branch = branchName(id, parsed.title);
      if (await branchExists(project.path, branch)) {
        throw new UserError(
          `${project.id} already has a branch ${branch}. majhi only works on a new task branch: delete or rename that branch, then create the task again.`,
          409,
        );
      }
      // No worktree yet. It will be `<folder>/<project>`, which TASK.md names.
      repos.push({
        project: project.id,
        source: project.path,
        base,
        branch,
        createdBranch: true,
      });
    }
    return { repos, warnings };
  }

  /** The registered projects the task's agents read read-only: its org's, or all for a task without an org. */
  private async readableProjects(task: Task): Promise<{ id: string; org: string; path: string }[]> {
    const all = await this.deps.projects.infos();
    return projectsFor(task.org ?? "root", all).map((p) => ({
      id: p.id,
      org: p.org,
      path: p.path,
    }));
  }

  private async writeBriefFiles(
    task: Task,
    agents: readonly AgentFrontmatter[],
    orgName: string | undefined,
    related: Related = NO_RELATED,
  ): Promise<void> {
    const team = briefTeam(task, agents);
    const md = renderTaskMd(
      task,
      team[0],
      orgName,
      related,
      team,
      await this.readFacts(task),
      this.deps.memory?.recalledText(task.id),
      await this.readableProjects(task),
      await this.briefConnections(task, agents),
    );
    const pointer = renderPointer(task);
    await Promise.all([
      writeFileAtomic(join(task.folder, "TASK.md"), md),
      writeFile(join(task.folder, "AGENTS.md"), pointer),
      writeFile(join(task.folder, "CLAUDE.md"), pointer),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Start, stop, close, remove

  /** Creates the missing worktrees, marks the task running and starts its agent. Safe to repeat. */
  async start(id: string, by = "owner"): Promise<Task> {
    const { store } = this.deps;
    const task = this.get(id);
    this.checkStartable(task);

    await this.ensureWorktrees(task);
    store.tasks.setStatus(id, "running", undefined, this.now().toISOString());
    store.tasks.setStartWhenReady(id, true);
    if (task.status === "paused") this.cards.settle(id, "paused", "Resumed", by);
    // The owner resumed a task a budget paused: it is not paused again for the alerts so far.
    if (task.status === "paused" && task.pausedReason === "limit" && by === "owner") {
      this.deps.onOwnerResumedLimit?.(id);
    }
    if (task.status === "paused" && by === "owner") this.deps.onOwnerResumed?.(id);
    await this.containersRunAgain(id);
    await this.recallMemory(task);
    const started = this.get(id);
    this.deps.room.publishTask(started);
    const first = await this.firstAgents(started);
    first.forEach((agent, i) => {
      // The first agent gets the task's brief; others that start with it get their own, once.
      this.deps.runs.startTask(started, agent, { ownBrief: i > 0 });
    });
    return started;
  }

  /**
   * Throws when the task cannot start now: done, no agent, or dependencies not met. With unmet
   * dependencies the owner's wish is kept: it starts by itself when the last one is met.
   */
  private checkStartable(task: Task): void {
    const { store } = this.deps;
    const id = task.id;
    if (task.status === "done") throw new UserError(`Task ${id} is done.`, 409);
    const waiting = store.tasks.unmetDependencies(id);
    if (waiting.length > 0) {
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
  }

  /** Who goes first when the task starts, by its mode: the lead, the pipeline's first step, the loop's builder. */
  private async firstAgents(task: Task): Promise<string[]> {
    return firstTurn(task.mode, this.members(task, await this.frontmatters())).agents;
  }

  /** Creates the worktrees the task does not have yet, each from its base (or the branch it stacks on). */
  async ensureWorktrees(task: Task): Promise<void> {
    const { store } = this.deps;
    const id = task.id;
    for (const repo of task.repos) {
      if (repo.worktree !== undefined) continue;
      // Agents only ever commit on a task branch, never on a branch the owner works on.
      if (!repo.branch.startsWith("task/")) {
        throw new UserError(
          `${repo.project}: ${repo.branch} is not a task branch. majhi only lets agents work on a new task/ branch. Create the task again.`,
          409,
        );
      }
      const path = join(task.folder, repo.project);
      // A `ready` dependency on the same project: this branch starts from its branch (5.4a).
      const stack = this.stackFor(task, repo.project);
      try {
        const result = await createWorktree({
          source: repo.source,
          base: stack?.branch ?? repo.base,
          branch: repo.branch,
          path,
          task: id,
          ...(stack === undefined ? {} : { localBase: true }),
          ...(this.deps.reloadKeys ? { reloadKeys: this.deps.reloadKeys } : {}),
        });
        store.tasks.setWorktree(id, repo.project, path, result.createdBranch, result.startCommit);
        if (stack !== undefined && result.createdBranch) {
          store.tasks.setBase(id, repo.project, stack.branch);
          store.tasks.setStack(id, repo.project, {
            ...stack,
            commit: await headOf(path),
          });
          this.note(id, `${repo.project}: stacked on ${stack.task}'s branch ${stack.branch}.`);
        }
        for (const w of result.warnings) this.warn(id, `${repo.project}: ${w}`);
      } catch (err) {
        if (err instanceof WorktreeProblem) throw new UserError(`${repo.project}: ${err.message}`, 409);
        throw new UserError(`${repo.project}: ${err instanceof Error ? err.message : String(err)}`, 409);
      }
    }
  }

  /**
   * Gives the task the facts memory holds for its org and repos, with the brief as the query, and
   * writes them into TASK.md (5.6). Memory that cannot answer never stops a task from starting.
   */
  private async recallMemory(task: Task): Promise<void> {
    const { memory, memoryScopes } = this.deps;
    if (memory === undefined || memoryScopes === undefined) return;
    try {
      const scopes = await memoryScopes.recall(task.id);
      if (scopes === undefined) return;
      await memory.recall(task, scopes);
      await this.refreshBriefs([task.id]);
    } catch (err) {
      this.warn(task.id, `Memory was not recalled: ${err instanceof Error ? err.message : String(err)}`);
    }
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
    return task.team.map((id) => ({
      id,
      role: agents.find((a) => a.id === id)?.role ?? "Builder",
    }));
  }

  /** Cancels every turn, closes the sessions, and pauses a running or reviewed task with reason owner. */
  /** `by`: who stopped it (`owner`, an agent id, `autonomy`), so the paused card can say the captain did. */
  async stop(
    id: string,
    reason: "owner" | "loop" | "blocked" = "owner",
    why?: string,
    by = "owner",
  ): Promise<Task> {
    const task = this.get(id);
    await this.deps.runs.stop(id);
    // Before the processes stop: it notes which services ran, to start them again on resume.
    await this.deps.containers?.taskPaused(id);
    await this.deps.processes?.stopTask(id);
    this.deps.terminals?.killKey(taskTerminalKey(id));
    this.dropPendingShip(id, "you stopped the task");
    if (task.status === "running" || task.status === "paused" || task.status === "review") {
      // Who paused it is kept for the labels: by the captain, or when Autonomous was turned off.
      const pausedBy =
        by === "autonomy-off" ? "autonomy-off" : this.cards.byCaptain(by) ? "captain" : undefined;
      this.deps.store.tasks.setStatus(id, "paused", reason, this.now().toISOString(), pausedBy);
    }
    const stopped = this.get(id);
    if (task.status === "running" || task.status === "review") this.cards.paused(stopped, reason, why, by);
    this.deps.room.publishTask(stopped);
    return stopped;
  }

  /**
   * Changes the title and the description, the owner's priority and deadline (null clears
   * one), and the starting branch before the task starts. Key, folder and branch stay; TASK.md is
   * written again.
   */
  async update(input: {
    id: string;
    title?: string | undefined;
    brief?: string | undefined;
    agent?: string | undefined;
    mode?: CoordinationMode | undefined;
    priority?: TaskPriority | null | undefined;
    due?: string | null | undefined;
    base?: string | undefined;
    project?: string | undefined;
  }): Promise<Task> {
    const task = this.get(input.id);
    if (input.base !== undefined) await this.changeBase(task, input.base, input.project);
    else if (input.project !== undefined)
      throw new UserError("project goes with base: give the new base too.");
    if (input.agent !== undefined && input.agent !== task.team[0]) await this.changeAgent(task, input.agent);
    if (input.mode !== undefined && input.mode !== task.mode) await this.changeMode(task, input.mode);
    if (input.priority !== undefined || input.due !== undefined)
      this.deps.store.tasks.setPlanning(
        task.id,
        { priority: input.priority, due: input.due },
        this.now().toISOString(),
      );
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

  /**
   * Moves a repo's starting branch while the task waits: in the inbox or ready, before its worktree
   * exists. The new base must be in the repo. The task branch name stays.
   */
  private async changeBase(task: Task, base: string, project: string | undefined): Promise<void> {
    if (task.repos.length === 0) throw new UserError(`${task.id} has no repo, so it has no starting branch.`);
    if (project === undefined && task.repos.length > 1)
      throw new UserError(
        `${task.id} has more than one repo. Say which with project: ${task.repos.map((r) => r.project).join(", ")}.`,
      );
    const repo = project === undefined ? task.repos[0] : task.repos.find((r) => r.project === project);
    if (repo === undefined) throw new UserError(`${task.id} has no repo ${project}.`, 404);
    if (repo.base === base) return;
    if ((task.status !== "inbox" && task.status !== "ready") || repo.worktree !== undefined)
      throw new UserError(
        `${task.id} has started, so its starting branch stays ${repo.base}. Only a task that has not started can change it.`,
        409,
      );
    if (!(await baseExists(repo.source, base)))
      throw new UserError(
        `${repo.project} has no branch ${base}. The starting branch stays ${repo.base}.`,
        409,
      );
    this.deps.store.tasks.setRepoBase(task.id, repo.project, base, this.now().toISOString());
    this.note(
      task.id,
      `Starting branch${task.repos.length > 1 ? ` of ${repo.project}` : ""}: ${base}, was ${repo.base}.`,
    );
  }

  /** A new coordination mode starts its own turn order; the loop guard's count and the removed agents stay. */
  private async changeMode(task: Task, mode: CoordinationMode): Promise<void> {
    const at = this.now().toISOString();
    this.deps.store.tasks.setMode(task.id, mode, at);
    const next = this.get(task.id);
    const { state } = firstTurn(mode, this.members(next, await this.frontmatters()));
    const { agentTurns, removed } = this.deps.store.tasks.roomState(task.id);
    this.deps.store.tasks.setRoomState(task.id, {
      ...state,
      agentTurns,
      ...(removed === undefined ? {} : { removed }),
    });
    this.note(task.id, `Mode: ${MODE_LABELS[mode]}.`);
  }

  // ---------------------------------------------------------------------------
  // Team (5.3)

  /** Adds an agent that can work in the task's org. With `lead`, it goes first. */
  async addToTeam(id: string, agent: string, options: { lead?: boolean; by?: string } = {}): Promise<Task> {
    const task = this.get(id);
    const state = this.deps.store.tasks.roomState(id);
    const removed = state.removed ?? [];
    if (options.by !== undefined && removed.includes(agent))
      throw new UserError(`The owner removed @${agent} from ${id}. Only the owner can add it back.`, 409);
    const fm = await this.checkMember(task, agent);
    // The owner added it again: agents may mention it as usual.
    if (removed.includes(agent))
      this.deps.store.tasks.setRoomState(id, {
        ...state,
        removed: removed.filter((a) => a !== agent),
      });
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
    const held = await this.stopProcessesOf(id, agent);
    const at = this.now().toISOString();
    this.deps.store.tasks.setTeam(
      id,
      task.team.filter((a) => a !== agent),
      at,
    );
    const { [agent]: _gone, ...overrides } = task.overrides;
    this.deps.store.tasks.setOverrides(id, overrides, at);
    // Mentions do not bring it back, so the room cannot wake it again.
    const state = this.deps.store.tasks.roomState(id);
    const removed = [...(state.removed ?? []).filter((a) => a !== agent), agent];
    this.deps.store.tasks.setRoomState(id, { ...state, removed });
    this.note(id, `Removed @${agent} from the team.`);
    return this.afterProcessesOf(id, held, await this.teamChanged(id));
  }

  /** Puts another agent in an agent's place in the team. The old session closes. */
  async swapInTeam(id: string, agent: string, replacement: string): Promise<Task> {
    const task = this.get(id);
    if (!task.team.includes(agent)) throw new UserError(`@${agent} is not on ${id}.`, 404);
    if (task.team.includes(replacement)) throw new UserError(`@${replacement} is already on ${id}.`, 409);
    const fm = await this.checkMember(task, replacement);
    await this.deps.runs.remove(id, agent);
    const held = await this.stopProcessesOf(id, agent);
    const at = this.now().toISOString();
    this.deps.store.tasks.setTeam(
      id,
      task.team.map((a) => (a === agent ? replacement : a)),
      at,
    );
    const { [agent]: _gone, ...overrides } = task.overrides;
    this.deps.store.tasks.setOverrides(id, overrides, at);
    this.note(id, `@${replacement} (${fm.role}) took @${agent}'s place.`);
    return this.afterProcessesOf(id, held, await this.teamChanged(id));
  }

  /**
   * Makes `agent` the lead (SPEC 5.18, lead handover). The owner, the captain and the current lead
   * may; any other agent is refused. The new lead is on the team or is added (it must be allowed in
   * the task's workspace, on an account that can run). The old lead stays as a builder unless
   * `keepOldLead` is false. The room gets a note with the plan, what is done and what is next, and
   * the new lead is woken with it.
   */
  async setLead(input: {
    task: string;
    agent: string;
    reason?: string | undefined;
    keepOldLead?: boolean | undefined;
    by: { kind: "owner" } | { kind: "agent"; id: string };
  }): Promise<Task> {
    const task = this.get(input.task);
    const old = task.team[0];
    const byName = input.by.kind === "owner" ? "the owner" : `@${input.by.id}`;
    if (input.by.kind === "agent") {
      const captain = this.deps.config.knownBoss();
      if (input.by.id !== captain && input.by.id !== old) {
        throw new UserError(
          `Only the owner, the captain or the lead, @${old ?? "nobody"}, can change the lead of ${task.id}.`,
          409,
        );
      }
    }
    if (old === input.agent) throw new UserError(`@${input.agent} is already the lead of ${task.id}.`, 409);
    if (task.status === "done") throw new UserError(`${task.id} is done.`, 409);
    const fm = await this.checkMember(task, input.agent);
    const view = (await this.deps.accounts.list().catch(() => [])).find((v) => v.id === fm.account);
    if (view !== undefined && ["needs-login", "at-limit", "unreachable"].includes(view.status)) {
      throw new UserError(
        `@${input.agent} runs on ${fm.account}, which cannot run now (${view.status}).`,
        409,
      );
    }
    const state = this.deps.store.tasks.roomState(task.id);
    if (input.by.kind === "agent" && (state.removed ?? []).includes(input.agent)) {
      throw new UserError(
        `The owner removed @${input.agent} from ${task.id}. Only the owner can add it back.`,
        409,
      );
    }
    if ((state.removed ?? []).includes(input.agent)) {
      this.deps.store.tasks.setRoomState(task.id, {
        ...state,
        removed: (state.removed ?? []).filter((a) => a !== input.agent),
      });
    }
    const keep = input.keepOldLead !== false;
    const rest = task.team.filter((a) => a !== input.agent && a !== old);
    const team = [input.agent, ...(old !== undefined && keep ? [old] : []), ...rest];
    const at = this.now().toISOString();
    const plan = this.deps.store.plans.forTask(task.id).at(-1)?.plan;
    const commits = await this.recentCommits(task);
    this.deps.store.tasks.setTeam(task.id, team, at);
    if (old !== undefined && !keep) {
      // The old lead's session is closed unless it is mid-turn (it is the caller when it hands over):
      // then it ends by itself and nothing wakes it again.
      if (!this.deps.runs.working(task.id).includes(old)) {
        await this.deps.runs.remove(task.id, old);
        await this.stopProcessesOf(task.id, old);
      }
      const { [old]: _gone, ...overrides } = task.overrides;
      this.deps.store.tasks.setOverrides(task.id, overrides, at);
    }
    const note = handoverNote({
      task: task.id,
      from: old ?? "nobody",
      to: input.agent,
      reason: input.reason,
      by: byName,
      plan,
      commits,
      oldStays: old !== undefined && keep,
    });
    this.deps.room.post(task.id as TaskId, `handover:${randomUUID()}`, {
      type: "system",
      level: "info",
      text: note,
    });
    const changed = await this.teamChanged(task.id);
    this.deps.runs.notify(task.id, input.agent, note);
    return changed;
  }

  /** Sets the team of a task that has not started (the captain's staffing). The first is the lead. */
  async staffTeam(id: string, team: readonly string[]): Promise<Task> {
    const task = this.get(id);
    if (team.length === 0 || team.join() === task.team.join()) return task;
    for (const agent of team) await this.checkMember(task, agent);
    const at = this.now().toISOString();
    this.deps.store.tasks.setTeam(id, [...team], at);
    const overrides = Object.fromEntries(Object.entries(task.overrides).filter(([a]) => team.includes(a)));
    this.deps.store.tasks.setOverrides(id, overrides, at);
    return this.teamChanged(id);
  }

  /** The newest commits of the task's branch in each repo since its base, newest first. */
  private async recentCommits(task: Task): Promise<{ project: string; subjects: string[] }[]> {
    const out: { project: string; subjects: string[] }[] = [];
    for (const repo of task.repos) {
      if (repo.worktree === undefined) continue;
      const log = await git(repo.worktree, ["log", "--format=%s", "-n", "8", `${repo.base}..HEAD`]).catch(
        () => "",
      );
      out.push({ project: repo.project, subjects: log.split("\n").filter((l) => l.trim() !== "") });
    }
    return out;
  }

  /** Stops the processes of an agent leaving the team. True when one of them held the task running. */
  private async stopProcessesOf(id: string, agent: string): Promise<boolean> {
    const held = (this.deps.processes?.waiting(id) ?? []).some((p) => p.agent === agent);
    await this.deps.processes?.stopAgent(id, agent);
    return held;
  }

  /** A stop by the task never checks for review itself (5.15), so a team change that ended a hold does. */
  private async afterProcessesOf(id: string, held: boolean, task: Task): Promise<Task> {
    if (!held) return task;
    await this.agentsIdle(id);
    return this.get(id);
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
    // An open session switches now to the value that applies. `auto` picks when a session starts,
    // and a cleared value with nothing in the agent's file leaves the session as it is.
    const file = (await this.frontmatters()).find((a) => a.id === input.agent);
    const applies = (value: string | null | undefined, fromFile: string | undefined) => {
      if (value === undefined) return undefined;
      const next = value ?? fromFile;
      return next === AUTO ? undefined : next;
    };
    const model = applies(input.model, file?.model);
    const effort = applies(input.effort, file?.effort);
    const live: { model?: string; effort?: string } = {
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    };
    const now =
      Object.keys(live).length > 0 &&
      (await this.deps.runs.applyOptions(task.id, input.agent, live).catch(() => false));
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
  /**
   * The loop guard's pause (`loop`: the agents went in circles), or the idle watch's (`blocked`:
   * nobody is left to wake), so the owner decides how to continue.
   */
  async pauseForOwner(id: string, text: string, reason: "loop" | "blocked" = "loop"): Promise<void> {
    this.deps.room.post(id as TaskId, `error:${randomUUID()}`, {
      type: "system",
      level: "warn",
      text,
    });
    await this.stop(id, reason);
    this.deps.events.emit(["tasks"]);
  }

  /**
   * Splits a task into children (5.4a): each child is a full task under this one, and can wait
   * for earlier children. Children are created in order, so a failure leaves the ones before it.
   */
  async split(input: {
    task: string;
    /** The task of the agent that asked, for attachments by path. */
    from?: string | undefined;
    children: {
      text: string;
      repos?: readonly PickedRepo[] | undefined;
      attachments?: string[] | undefined;
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
    // Every entry is checked before the first child exists, so a bad one leaves nothing behind.
    await this.checkAttachments(
      input.children.flatMap((c) => c.attachments ?? []),
      input.from,
    );
    const made: Task[] = [];
    for (const child of input.children) {
      const dependsOn = child.dependsOn.flatMap((d) => (made[d] === undefined ? [] : [made[d].id]));
      made.push(
        await this.create({
          text: child.text,
          repos: child.repos,
          agent: child.agent,
          attachments: child.attachments ?? [],
          from: input.from,
          start: false,
          parent: parent.id,
          dependsOn,
          dependsWhen: child.when,
        }),
      );
    }
    this.note(parent.id, `Split into ${made.map((t) => t.id).join(", ")}.`);
    if (input.start) {
      // The children start one by one as the plan allows: overlap, links and limits are checked first.
      for (const t of made) {
        this.deps.store.tasks.setStartWhenReady(t.id, true);
        this.deps.store.tasks.setStatus(t.id, "ready", undefined, this.now().toISOString());
        this.deps.room.publishTask(this.get(t.id));
      }
      await this.orchestrator.advance();
    }
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

  /**
   * Marks a task done. A parent with open subtasks is not done: an explicit close is refused, and a
   * close after a merge (`stay`) keeps it open, says so, and lets it close with its last subtask.
   * Work not shipped (commits not merged, pushed or in a pull request) is refused with what it is,
   * unless the owner keeps it (`keep`); `stay` leaves the task open and says why. An agent is
   * refused whatever it asks: only the owner may leave commits behind.
   */
  async close(
    id: string,
    opts: {
      whenSubtasksOpen?: "refuse" | "stay";
      /** Who closes it, as the room shows it: `owner`, an agent id, or `majhi`. */
      by?: string | undefined;
      /** True when an agent asks. */
      agent?: boolean;
      whenUnshipped?: "refuse" | "keep" | "stay";
      /** What the review card says when it settles with the close. Default "Marked done". */
      reviewText?: string;
    } = {},
  ): Promise<Task> {
    const task = this.get(id);
    if (task.status === "done") return task;
    this.deps.guardRemoval?.(task, "close");
    const open = this.openSubtasks(id);
    if (open.length > 0) {
      const list = `${open.slice(0, 5).join(", ")}${open.length > 5 ? ", ..." : ""}`;
      if (opts.whenSubtasksOpen === "stay") {
        this.note(
          id,
          `${id} stays open: ${open.length} subtask${open.length === 1 ? "" : "s"} not done yet (${list}). It closes when the last one is done.`,
        );
        return task;
      }
      throw new UserError(
        `${id} has ${open.length} open subtask${open.length === 1 ? "" : "s"} (${list}). It closes by itself when they are done.`,
        409,
      );
    }
    const when = opts.agent === true ? "refuse" : (opts.whenUnshipped ?? "refuse");
    const unshipped = when === "keep" ? [] : await unshippedWork(task.repos);
    if (unshipped.length > 0) {
      const what = unshippedText(unshipped);
      if (when === "stay") {
        this.note(id, `${id} stays open: ${what}`);
        return task;
      }
      throw new UserError(
        opts.agent === true
          ? `${id} cannot be closed yet. ${what} Ship it first: merge it with the merge tool if you have the Merge permission; a push or a pull request needs the owner's approval or an org policy. Or leave it in review, and the owner ships or closes it from the review card.`
          : `${what} Close it anyway to leave the commits on the branch.`,
        409,
      );
    }
    await this.deps.runs.stop(id);
    await this.deps.processes?.stopTask(id);
    await this.deps.containers?.taskEnded(id);
    this.deps.terminals?.killKey(taskTerminalKey(id));
    this.deps.store.tasks.setPendingShip(id, undefined);
    this.deps.store.tasks.setStatus(id, "done", undefined, this.now().toISOString());
    this.cards.settle(id, "review", opts.reviewText ?? "Marked done", opts.by ?? "owner");
    this.cards.settle(id, "paused", "Closed", opts.by ?? "owner");
    const closed = this.get(id);
    this.deps.room.publishTask(closed);
    await this.statusChanged(id);
    await Promise.resolve(this.deps.onDone?.(closed)).catch(() => undefined);
    return closed;
  }

  /**
   * A task no agent runs: majhi makes its worktrees, `change` edits them, each changed worktree gets
   * one commit, and the task waits in review for the owner to merge. Nothing is pushed. A failed
   * change leaves the task in the inbox, with the reason in its room.
   */
  async createChange(input: {
    text: string;
    /** The repo the change is made in. Named explicitly: text never attaches a repo. */
    project: string;
    message: string;
    change: (repo: { project: string; worktree: string }) => Promise<void>;
  }): Promise<Task> {
    const created = await this.create({
      text: input.text,
      repos: [{ project: input.project }],
      attachments: [],
      start: false,
    });
    const task = this.get(created.id);
    try {
      await this.ensureWorktrees(task);
      const sections = await this.deps.config.sections();
      const identity = sections.orgs[task.org ?? "private"]?.identity ?? DEFAULT_IDENTITY;
      const attribution = await attributionOf(this.deps.config, this.get(task.id));
      for (const repo of this.get(task.id).repos) {
        if (repo.worktree === undefined) continue;
        await input.change({ project: repo.project, worktree: repo.worktree });
        await commitAll(
          repo.worktree,
          input.message,
          commitBy(identity, task.id, undefined, attribution.repos[repo.project] !== false),
        );
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      this.warn(task.id, `The change was not made: ${why}`);
      throw err;
    }
    this.deps.store.tasks.setStatus(task.id, "review", undefined, this.now().toISOString());
    this.note(task.id, "majhi made this change itself, with no agent. Merge it to keep it.");
    const ready = this.get(task.id);
    this.deps.room.publishTask(ready);
    await this.statusChanged(task.id);
    return ready;
  }

  /**
   * Merges the task branch into a local branch in each changed repo's checkout (its base, or the
   * target picked for it), the way `method` says. Repos with no change are skipped. All or nothing:
   * every repo is checked first (committed, target there, no conflict), and one that cannot merge
   * stops them all before any merges. Refused while an agent of the task works. Never pushes. With
   * `deleteAfter`, a clean merge removes the worktree and the branch of each merged repo.
   */
  async merge(input: {
    id: string;
    into?: string | undefined;
    targets?: Readonly<Record<string, string>> | undefined;
    project?: string | undefined;
    /** The owner typed this protected repo's name to ship it alone. */
    confirmProtected?: string | undefined;
    done: boolean;
    by?: string | undefined;
    /** False: the caller settles the review card itself (a merge that also pushes). */
    settle?: boolean | undefined;
    method?: MergeMethod | undefined;
    deleteAfter?: boolean | undefined;
  }) {
    const task = this.get(input.id);
    if (this.deps.runs.working(task.id).length > 0) {
      throw new UserError(
        `An agent of ${task.id} is working. Wait for its turn to end or stop it, then merge.`,
        409,
      );
    }
    const plan = await this.shipPlan(task, input);
    if (input.deleteAfter === true) await this.assertDeletable(plan.ship.map((s) => s.repo));
    const org = (await this.deps.config.sections()).orgs[task.org ?? "private"];
    const identity = org?.identity ?? DEFAULT_IDENTITY;
    type Result = {
      project: string;
      into: string;
      ok: boolean;
      detail: string;
      conflicts?: string[];
      skipped?: boolean;
    };
    const skipped: Result[] = [...plan.unchanged.map(skippedResult), ...plan.held.map(heldResult)];
    const by = input.by ?? "owner";
    const report = (results: Result[]) => {
      for (const r of results) this.note(task.id, `${r.project}: ${r.detail}`);
      for (const r of results) {
        if (r.skipped === true) continue;
        logShip(this.deps.store, {
          task: task.id,
          kind: "merge",
          who: by,
          ok: r.ok,
          project: r.project,
          detail: r.ok ? r.into : `${r.into}: ${r.detail}`,
          at: this.now(),
        });
      }
    };

    // Check every repo before merging any, so one that cannot merge leaves the others untouched.
    const blocked = new Map<string, { reason: string; conflicts?: string[] }>();
    for (const { repo, into } of plan.ship) {
      const dirty = repo.worktree === undefined ? [] : await uncommitted(repo.worktree).catch(() => []);
      const blocker = dirty.some((l) => !l.startsWith("??"))
        ? {
            reason: "The task's worktree has uncommitted changes. Ask the agent to commit them first.",
          }
        : await mergeBlocker(repo.source, repo.branch, into).catch((err: unknown) => ({
            reason: errorMessage(err),
          }));
      if (blocker !== undefined) blocked.set(repo.project, blocker);
    }
    if (blocked.size > 0) {
      const names = [...blocked.keys()].join(", ");
      const results: Result[] = plan.ship.map(({ repo, into }) => {
        const b = blocked.get(repo.project);
        if (b === undefined) {
          return {
            project: repo.project,
            into,
            ok: false,
            detail: `Not merged: ${names} cannot merge, so nothing was merged.`,
          };
        }
        return {
          project: repo.project,
          into,
          ok: false,
          detail: b.conflicts === undefined ? b.reason : `Nothing was merged. ${b.reason}`,
          ...(b.conflicts === undefined ? {} : { conflicts: b.conflicts }),
        };
      });
      report(results);
      return { results: [...results, ...skipped], task: this.get(task.id) };
    }

    const results: Result[] = [];
    const heads = new Map<string, string>();
    let stopped: string | undefined;
    for (const { repo, into } of plan.ship) {
      if (stopped !== undefined) {
        results.push({
          project: repo.project,
          into,
          ok: false,
          detail: `Not tried: ${stopped} failed first.`,
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
        method: input.method,
      }).catch(
        (err: unknown): MergeOutcome => ({
          ok: false,
          reason: errorMessage(err),
        }),
      );
      if (outcome.ok) {
        heads.set(repo.project, outcome.head);
        this.deps.store.tasks.setShipped(task.id, repo.project, outcome.head, into);
        void Promise.resolve(this.deps.onMerged?.({ task: task.id, project: repo.project, into })).catch(
          () => undefined,
        );
        results.push({
          project: repo.project,
          into,
          ok: true,
          detail: mergedDetail(repo.branch, into, outcome.how),
        });
        continue;
      }
      stopped = repo.project;
      results.push({
        project: repo.project,
        into,
        ok: false,
        detail: outcome.reason,
        ...(outcome.conflicts === undefined ? {} : { conflicts: outcome.conflicts }),
      });
    }
    report(results);
    const merged = results.filter((r) => r.ok);
    if (stopped !== undefined) {
      if (merged.length > 0) {
        this.warn(
          task.id,
          `${stopped} did not merge after the checks passed. Already merged, not pushed: ${merged.map((r) => `${r.project} into ${r.into}`).join(", ")}. They stay merged in your checkout.`,
        );
      }
      return { results: [...results, ...skipped], task: this.get(task.id) };
    }
    // A protected repo left out still has work to ship: the task stays open for it.
    const done = input.done && plan.held.length === 0;
    const into = [...new Set(results.map((r) => r.into))].join(", ");
    const settle = input.settle !== false && plan.held.length === 0;
    const after = await this.closeAfterMerge(task.id, {
      done,
      into,
      settle,
      by,
    });
    if (input.deleteAfter !== true) return { results: [...results, ...skipped], task: after };
    const deleted = await this.deleteAfterShip(task.id, heads);
    return {
      results: [
        ...results.map((r) => {
          const extra = deleted.get(r.project);
          return extra === undefined ? r : { ...r, detail: `${r.detail} ${extra}` };
        }),
        ...skipped,
      ],
      task: this.get(task.id),
    };
  }

  /**
   * After a merge: closes the task when `done`, then settles the review card to match what
   * happened, so the card and the task status never disagree.
   */
  async closeAfterMerge(
    id: string,
    opts: {
      done: boolean;
      into: string;
      settle: boolean;
      by: string;
      pushed?: boolean;
    },
  ): Promise<Task> {
    const merged = `Merged into ${opts.into}${opts.pushed === true ? " and pushed it" : ""}`;
    const after = opts.done
      ? await this.close(id, {
          whenSubtasksOpen: "stay",
          whenUnshipped: "stay",
          by: opts.by,
          ...(opts.settle
            ? {
                reviewText: `${merged}${opts.pushed === true ? ", marked done" : " and marked done"}`,
              }
            : {}),
        })
      : this.get(id);
    if (opts.settle && after.status !== "done") {
      const why = !opts.done
        ? ""
        : this.openSubtasks(id).length > 0
          ? "; still open because its subtasks are not done"
          : "; still open because its work is not shipped";
      this.cards.settle(id, "review", `${merged}${why}`, opts.by);
    }
    return after;
  }

  /**
   * What a ship sends: the task's repos with changes (only `project` when given), each with its
   * target, and the unchanged ones it skips. Refused when no repo has a change.
   */
  async shipPlan(
    task: Task,
    pick: ShipTargets & {
      project?: string | undefined;
      confirmProtected?: string | undefined;
    },
  ): Promise<ShipPlan> {
    const repos = task.repos.filter((r) => pick.project === undefined || r.project === pick.project);
    if (repos.length === 0) {
      throw new UserError(
        pick.project === undefined
          ? `${task.id} has no repo.`
          : `${pick.project} is not a repo of ${task.id}.`,
        409,
      );
    }
    const found = await shipPlan(repos, pick, task.repos);
    if (found.ship.length === 0) {
      throw new UserError(
        `Nothing to ship: ${repos.length === 1 ? `${repos[0]?.project} has` : "no repo of this task has"} changes since the task started.`,
        409,
      );
    }
    const guarded = new Set((await this.deps.projects.infos()).filter((p) => p.protected).map((p) => p.id));
    const plan = holdProtected(found, guarded, pick);
    for (const { repo, into } of plan.ship) {
      const refusal = await targetRefusal(repo, into, dirname(task.folder));
      if (refusal !== undefined) throw new UserError(refusal, 409);
    }
    return plan;
  }

  /**
   * "Delete after" is refused before a ship runs when a worktree holds uncommitted work, untracked
   * files included, so nothing is merged or pushed that the owner meant to clean up after.
   */
  async assertDeletable(repos: readonly TaskRepo[]): Promise<void> {
    for (const repo of repos) {
      const refusal = await deleteRefusal(repo);
      if (refusal !== undefined) throw new UserError(refusal, 409);
    }
  }

  /**
   * After a ship that succeeded: removes each repo's worktree and deletes its local branch when it
   * is still at the commit that was shipped (`heads`, by project). Says in the room what went and
   * what stayed, and returns that line by project.
   */
  async deleteAfterShip(id: string, heads: ReadonlyMap<string, string>): Promise<Map<string, string>> {
    const task = this.get(id);
    const stacked = this.deps.store.tasks.stackedOn(task.id);
    const out = new Map<string, string>();
    for (const repo of task.repos) {
      const head = heads.get(repo.project);
      if (head === undefined) continue;
      const done = await deleteAfterShip({
        repo,
        head,
        stacked: stacked.some((s) => s.project === repo.project && s.branch === repo.branch),
      }).catch((err: unknown) => ({
        worktreeRemoved: false,
        branchDeleted: false,
        detail: `Kept ${repo.branch} and its worktree: ${errorMessage(err)}`,
      }));
      if (done.worktreeRemoved) this.deps.store.tasks.clearWorktree(task.id, repo.project);
      this.note(task.id, `${repo.project}: ${done.detail}`);
      out.set(repo.project, done.detail);
    }
    const current = this.get(task.id);
    this.deps.room.publishTask(current);
    this.deps.events.emit(["tasks"]);
    return out;
  }

  /** What each repo of the task changed against its base, as git diffs. */
  async diff(id: string) {
    const task = this.get(id);
    const started = task.status !== "inbox" && task.status !== "ready";
    return Promise.all(task.repos.map((r) => repoDiff(r, { started })));
  }

  /** Local branches of each repo of the task, for picking where to merge. */
  async branches(id: string) {
    const task = this.get(id);
    return Promise.all(
      task.repos.map(async (r) => {
        const project = await this.deps.projects.get(r.project).catch(() => undefined);
        const remote = mrRemoteName(project?.remotes);
        return {
          project: r.project,
          base: r.base,
          branches: (await localBranches(r.source).catch(() => [r.base])).filter((b) => b !== r.branch),
          remote: (await remoteBranches(r.source, remote).catch(() => [])).filter((b) => b !== r.branch),
        };
      }),
    );
  }

  /** Subtasks of a task that are not done, in link order. */
  private openSubtasks(id: string): string[] {
    const { store } = this.deps;
    return store.tasks.children(id).filter((c) => store.tasks.get(c)?.status !== "done");
  }

  /** The first message names an untitled chat. */
  private nameChat(task: Task, text: string): void {
    if (!isOwnerChat(task) || !DEFAULT_CHAT_TITLES.includes(task.title)) return;
    const title = chatTitleFrom(text);
    if (title === undefined) return;
    this.deps.store.tasks.setText(task.id, title, task.brief, this.now().toISOString());
    this.deps.room.publishTask(this.get(task.id));
  }

  /** Renames a chat. The brief stays: it marks the task as a chat. */
  renameChat(id: string, title: string): Task {
    const task = this.get(id);
    if (!isOwnerChat(task)) throw new UserError(`Task ${id} is not a chat.`, 409);
    this.deps.store.tasks.setText(id, title.trim(), task.brief, this.now().toISOString());
    // The owner's title stays: majhi never names this chat again.
    this.deps.store.chats.markOwnerTitled(id);
    const renamed = this.get(id);
    this.deps.room.publishTask(renamed);
    this.deps.events.emit(["tasks"]);
    return renamed;
  }

  /** Gives a chat a title majhi made. False, and nothing changes, when the owner renamed it. */
  autoTitleChat(id: string, title: string): boolean {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || !isOwnerChat(task) || this.deps.store.chats.get(id).titledBy === "owner")
      return false;
    this.deps.store.tasks.setText(id, title, task.brief, this.now().toISOString());
    this.deps.room.publishTask(this.get(id));
    this.deps.events.emit(["tasks"]);
    return true;
  }

  /** Opens a done task again: back to review when it has a worktree, else the inbox. */
  async reopen(id: string): Promise<Task> {
    const task = this.get(id);
    if (task.status !== "done") return task;
    const status = task.repos.some((r) => r.worktree !== undefined) ? "review" : "inbox";
    this.deps.store.tasks.setStatus(id, status, undefined, this.now().toISOString());
    if (!isOwnerChat(task)) this.note(id, "Reopened.");
    const reopened = this.get(id);
    if (status === "review") this.cards.review(reopened);
    this.deps.room.publishTask(reopened);
    this.deps.events.emit(["tasks"]);
    return reopened;
  }

  /**
   * Deletes a task, its folder and its worktrees. Uncommitted changes go only with `force` and
   * `confirm`, the task id the owner typed after seeing the list of them. Agents never get here with
   * force (the admin tools refuse it). Changes that appear while the agents stop refuse the removal,
   * so what goes is what the owner saw.
   */
  async remove(id: string, force: boolean, confirm?: string): Promise<void> {
    const task = this.get(id);
    this.deps.guardRemoval?.(task, "remove");
    const trees = task.repos.flatMap((r) => (r.worktree === undefined ? [] : [r.worktree]));
    const dirty = await dirtyWorktrees(trees);
    if (dirty.length > 0 && !force) {
      throw discardRefusal(
        `Uncommitted changes in ${dirty.map((d) => d.path).join(", ")}. Commit or discard them, or remove with force.`,
        dirty,
      );
    }
    if (dirty.length > 0 && confirm?.trim().toUpperCase() !== task.id) {
      throw discardRefusal(
        `Removing ${task.id} deletes these uncommitted changes for good. Type ${task.id} to confirm.`,
        dirty,
      );
    }
    await this.deps.onRemoving?.(task).catch(() => undefined);
    await this.deps.runs.stop(id);
    await this.deps.processes?.stopTask(id);
    await this.deps.containers?.taskEnded(id);
    this.deps.terminals?.killKey(taskTerminalKey(id));
    this.deps.processes?.forget(id);
    if (force) {
      const seen = new Set(changeLines(dirty));
      const now = await dirtyWorktrees(trees);
      if (changeLines(now).some((line) => !seen.has(line))) {
        throw discardRefusal(
          `More uncommitted changes appeared while the agents of ${task.id} stopped. Check them, then type ${task.id} again to confirm.`,
          now,
        );
      }
    }
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
  // Parallel planning

  /** The owner's answer to a choice card in a room, or the captain's (`captain`: its agent id). */
  async answerChoice(task: string, item: string, option: string, captain?: string) {
    try {
      await this.orchestrator.answer(task, item, option, captain !== undefined);
    } catch (err) {
      throw new UserError(errorMessage(err), 409);
    }
    const answered = this.deps.room.get(task, item);
    if (answered === undefined) throw new UserError("The card is gone.", 404);
    return answered;
  }

  /** The owner's answers to an ask card, or the captain's (`captain`: its agent id). */
  async answerAsk(task: string, item: string, answers: Record<string, string>, captain?: string) {
    const card = this.deps.room.get(task, item);
    if (card?.type !== "ask" || card.state !== "pending") {
      throw new UserError("That is not a pending ask card.", 409);
    }
    const agent = card.agent;
    const questions = card.questions;
    const validated: Record<string, string> = {};

    for (const q of questions) {
      const answer = answers[q.id];
      if (answer === undefined) {
        throw new UserError(`Missing answer for question: ${q.question}`, 409);
      }
      const matchingOption = q.options.find((o) => o.id === answer);
      if (matchingOption !== undefined) {
        validated[q.id] = answer;
      } else if (q.freeText) {
        validated[q.id] = answer;
      } else {
        throw new UserError(`"${answer}" is not a valid option for: ${q.question}`, 409);
      }
    }

    const who = captain === undefined ? "Owner" : "The captain";
    const message =
      questions.length === 1
        ? (() => {
            const q = questions[0]!;
            const answer = validated[q.id];
            const option = q.options.find((o) => o.id === answer);
            return `${who} chose: ${option?.label ?? answer}`;
          })()
        : `${who} answered:\n${questions
            .map((q) => {
              const answer = validated[q.id];
              const option = q.options.find((o) => o.id === answer);
              return `${q.question}: ${option?.label ?? answer}`;
            })
            .join("\n")}`;

    this.deps.room.post(task as TaskId, item, {
      type: "ask",
      agent: card.agent,
      questions: card.questions,
      state: "answered",
      answers: validated,
      ...(captain === undefined ? {} : { by: "captain" as const }),
    });
    // The captain's answer is no owner message: the card says who answered.
    if (captain !== undefined)
      await this.tellAgent({ task, agent, text: message, settled: "The captain answered", by: captain });
    else
      await this.send({
        task,
        text: message,
        attachments: [],
        mode: "queue",
        agent,
      });
    return (
      this.deps.room.get(task, item) ??
      (() => {
        throw new Error("The ask card was not stored");
      })()
    );
  }

  // ---------------------------------------------------------------------------
  // Owner cards: review, paused, plain-text questions

  /** What the review card's buttons may do now, with the reason when not. */
  async reviewOptions(id: string): Promise<{ base?: string; merge: ShipOption; done: DoneOption }> {
    const task = this.get(id);
    const base = task.repos[0]?.base;
    return {
      ...(base === undefined ? {} : { base }),
      merge: await this.mergeOption(task),
      done: await this.doneOption(task),
    };
  }

  /**
   * Why a done task has nothing left to ship, or undefined when it is not done or some of its work
   * is not shipped: a repo with commits past its base (here and on the remote) that has no open or
   * merged merge request and was not pushed as it is now. Such a task keeps its Ship actions.
   */
  async doneAndShipped(task: Task): Promise<string | undefined> {
    if (task.status !== "done") return undefined;
    for (const repo of task.repos) {
      if (!(await this.workShipped(repo))) return undefined;
    }
    return `${task.id} is done, and its work is merged or pushed.`;
  }

  private async workShipped(repo: TaskRepo): Promise<boolean> {
    if (repo.mr !== undefined && repo.mr.state !== "closed") return true;
    if (!(await localBranchExists(repo.source, repo.branch))) return true;
    const ahead = await commitsSinceStart(repo.source, repo).catch(() => undefined);
    if (ahead === 0) return true;
    const project = await this.deps.projects.get(repo.project).catch(() => undefined);
    const remote = mrRemoteName(project?.remotes);
    for (const ref of [`refs/remotes/${remote}/${repo.base}`, `refs/remotes/${remote}/${repo.branch}`]) {
      if (
        await git(repo.source, ["merge-base", "--is-ancestor", repo.branch, ref]).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  }

  private async mergeOption(task: Task): Promise<{ ok: boolean; why?: string }> {
    const shipped = await this.doneAndShipped(task);
    if (shipped !== undefined) return { ok: false, why: shipped };
    if (task.repos.length === 0) return { ok: false, why: "The task has no repo to merge." };
    const trees = task.repos.filter((r) => r.worktree !== undefined);
    if (trees.length === 0) return { ok: false, why: "The task has no worktree yet." };
    if (this.deps.runs.working(task.id).length > 0)
      return {
        ok: false,
        why: "An agent is working. Merge when its turn ends.",
      };
    let known = true;
    let ahead = 0;
    for (const r of trees) {
      const n = await commitsSinceStart(r.source, r).catch(() => undefined);
      if (n === undefined) known = false;
      else ahead += n;
    }
    if (!known || ahead > 0) return { ok: true };
    const dirty = await dirtyWorktrees(trees.flatMap((r) => (r.worktree === undefined ? [] : [r.worktree])));
    return {
      ok: false,
      why:
        dirty.length > 0
          ? "The changes are not committed yet. Ask the agent to commit them."
          : `Nothing to merge: no commits ahead of ${trees[0]?.base ?? "the base"}.`,
    };
  }

  private async doneOption(task: Task): Promise<DoneOption> {
    if (task.status === "done") return { ok: false, why: `${task.id} is done.` };
    const open = this.openSubtasks(task.id);
    if (open.length === 0) {
      const unshipped = await unshippedWork(task.repos);
      return unshipped.length === 0 ? { ok: true } : { ok: true, unshipped };
    }
    const list = `${open.slice(0, 5).join(", ")}${open.length > 5 ? ", ..." : ""}`;
    return {
      ok: false,
      why: `${open.length} subtask${open.length === 1 ? " is" : "s are"} not done (${list}). It closes by itself when they are.`,
    };
  }

  /**
   * One of the choices under an agent's plain-text question: sent to that agent as the owner's
   * answer, or as the captain's (`captain`: its agent id).
   */
  async answerQuestion(task: string, item: string, choice: string, captain?: string): Promise<RoomItem> {
    const card = this.deps.room.get(task, item);
    if (card?.type !== "owner-question") throw new UserError("That is not a question card.", 404);
    if (card.state !== "pending") throw new UserError("This question was already answered.", 409);
    if (!card.choices.includes(choice)) throw new UserError(`"${choice}" is not one of the choices.`, 409);
    const current = this.get(task);
    if (current.status === "done") throw new UserError(`Task ${current.id} is done.`, 409);
    if (!current.team.includes(card.agent))
      throw new UserError(`@${card.agent} is not on ${current.id} any more.`, 409);
    const { id: _id, task: _task, seq: _seq, at: _at, ...fields } = card;
    // Marked before anything is awaited, so a second click finds it answered.
    this.deps.room.post(current.id, item, {
      ...fields,
      state: "answered",
      chosen: choice,
      ...(captain === undefined ? {} : { by: "captain" as const }),
    });
    try {
      if (captain !== undefined)
        await this.tellAgent({
          task,
          agent: card.agent,
          text: `The captain chose: ${choice}`,
          settled: "The captain answered",
          by: captain,
        });
      else
        await this.send({
          task,
          text: `Owner chose: ${choice}`,
          attachments: [],
          mode: "queue",
          agent: card.agent,
        });
    } catch (err) {
      this.deps.room.post(current.id, item, fields);
      throw err;
    }
    return this.deps.room.get(task, item) ?? card;
  }

  /**
   * "What can I start now?": the same check a lead makes before it starts a task, for one task,
   * for a parent's waiting children, or for every task waiting to start. Changes nothing.
   */
  async plan(id: string | undefined) {
    const { store } = this.deps;
    const subject = id === undefined ? undefined : this.get(id);
    const ids =
      subject === undefined
        ? store.tasks.list(false).map((t) => t.id)
        : store.tasks.children(subject.id).length > 0
          ? store.tasks.children(subject.id)
          : [subject.id];
    const entries = [];
    for (const taskId of ids.reverse()) {
      const task = store.tasks.get(taskId);
      if (task === undefined || (task.status !== "inbox" && task.status !== "ready")) continue;
      const waiting = store.tasks.unmetDependencies(taskId);
      const plan = await this.planner.plan(task);
      // A link that only holds the task back does not count as a reason to wait.
      const blockers = waiting.filter((w) => !plan.redundant.includes(w));
      const base = { task: task.id, title: task.title };
      if (blockers.length > 0) {
        entries.push({
          ...base,
          action: "blocked" as const,
          because: `waits for ${blockers.join(", ")}`,
        });
        continue;
      }
      const v = plan.verdict;
      const because =
        v.action === "start"
          ? (v.note ?? "no overlap with the running tasks, and the account has room")
          : v.action === "switch"
            ? `${v.because}; @${v.agent.agent} on ${v.agent.account} has room`
            : v.action === "wait"
              ? `${v.because}`
              : v.action === "queue"
                ? v.because
                : `overlaps ${v.on.join(", ")} in ${v.module}; the owner chooses`;
      entries.push({ ...base, action: v.action, because });
    }
    return { entries };
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
      await this.orchestrator.advance();
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
    this.pauseForUnmerged(task, held);
    this.orchestrator.childReady(task);
    // Waiting tasks that are free now, and queued ones that a freed slot or account may let in.
    await this.orchestrator.advance();
    if (parent !== undefined) await this.finishParentIfDone(parent);
    await this.plans.settle(task).catch(() => undefined);
    await this.refreshBriefs([id, ...held.map((l) => l.task), ...(parent === undefined ? [] : [parent])]);
    this.deps.events.emit(["tasks"]);
  }

  /**
   * A task was closed with a merge request that is not merged (5.4a, 5.5). Tasks that wait for it
   * with `merged` do not start on a base without its work: they pause with reason `owner` and say
   * what to do. They stay unmet, and the merge poller keeps watching the open merge requests.
   */
  private pauseForUnmerged(
    task: Task,
    held: readonly {
      task: string;
      type: TaskLink["type"];
      when?: TaskLink["when"] | undefined;
    }[],
  ): void {
    const { store } = this.deps;
    if (task.status !== "done") return;
    const open = task.repos.filter((r) => r.mr !== undefined && r.mr.state !== "merged");
    if (open.length === 0) return;
    for (const link of held) {
      if (link.type !== "depends-on" || link.when === "ready") continue;
      const waiting = store.tasks.get(link.task);
      if (waiting?.status !== "inbox" && waiting?.status !== "ready") continue;
      store.tasks.setStartWhenReady(waiting.id, false);
      store.tasks.setStatus(waiting.id, "paused", "blocked", this.now().toISOString());
      this.deps.room.post(waiting.id, `error:${randomUUID()}`, {
        type: "system",
        level: "error",
        text: `${task.id} was closed, but its merge request${open.length === 1 ? " is" : "s are"} not merged (${open.map((r) => `${r.project} is ${r.mr?.state}`).join(", ")}). This task waits for the merge. Merge ${open.length === 1 ? "it" : "them"}, or remove the link to ${task.id} and start this task.`,
      });
      this.deps.room.publishTask(this.get(waiting.id));
    }
  }

  /** The lead records its plan (majhi-room `record_plan`). */
  async recordPlan(id: string, agent: string, plan: TeamPlan): Promise<string> {
    const task = this.get(id);
    return this.plans.record(task, agent, plan);
  }

  /** The team as it is now, for the snapshot kept with a plan: from the last facts, else from the agent files. */
  private async planTeam(task: Task): Promise<PlanMember[]> {
    const facts = await this.knownFacts(task);
    if (facts !== undefined) {
      return facts.members.map((m) => ({
        id: m.id,
        role: m.role,
        ...(m.model === undefined ? {} : { model: m.model }),
        ...(m.tier === undefined ? {} : { tier: m.tier }),
        account: m.account,
      }));
    }
    const stored = await this.deps.agents.list();
    const agents = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    return task.team.flatMap((id) => {
      const fm = agents.find((a) => a.id === id);
      return fm === undefined
        ? []
        : [
            {
              id,
              role: fm.role,
              ...(fm.model === undefined || fm.model === AUTO ? {} : { model: fm.model }),
              account: fm.account,
            },
          ];
    });
  }

  /**
   * Closes a parent once every subtask is done. A parent with work of its own not shipped stays open
   * (said once) and goes to review when nobody works on it, so the owner ships it or closes it.
   */
  private async finishParentIfDone(parent: string): Promise<void> {
    const { store } = this.deps;
    const task = store.tasks.get(parent);
    if (task === undefined || task.status === "done" || !store.tasks.childrenDone(parent)) return;
    const unshipped = await unshippedWork(task.repos);
    if (unshipped.length > 0) {
      const text = `Every subtask is done, but ${parent} stays open: ${unshippedText(unshipped)} Ship it, or close it from the review card.`;
      if (!this.waitNoted.has(`${parent} ${text}`)) {
        this.waitNoted.add(`${parent} ${text}`);
        this.note(parent, text);
      }
      await this.agentsIdle(parent);
      return;
    }
    this.note(parent, this.orchestrator.report(parent));
    await this.close(parent, { by: "majhi", whenUnshipped: "stay" });
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
      store.tasks.setStatus(waiting.id, "paused", "blocked", this.now().toISOString());
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

  /** Fresh team facts, remembered for the task's team. Undefined when they do not apply. */
  private async readFacts(task: Task): Promise<TeamFacts | undefined> {
    const facts = await this.teamFacts.facts(task);
    if (facts === undefined) this.lastFacts.delete(task.id);
    else this.lastFacts.set(task.id, { team: task.team.join(","), facts });
    return facts;
  }

  /** The facts last read for this team, or fresh ones when there are none yet. */
  private async knownFacts(task: Task): Promise<TeamFacts | undefined> {
    const known = this.lastFacts.get(task.id);
    return known?.team === task.team.join(",") ? known.facts : this.readFacts(task);
  }

  /** The connections the task's team may hold (5.14), for TASK.md. Never a value. */
  private async briefConnections(
    task: Task,
    agents: readonly AgentFrontmatter[],
  ): Promise<BriefConnection[]> {
    const { orgs } = await this.deps.config.sections();
    const found = new Map<string, BriefConnection>();
    for (const fm of agents.filter((a) => task.team.includes(a.id))) {
      const held = runConnections({
        agent: { scope: fm.scope, connections: fm.connections },
        task: { org: task.org, connections: task.connections ?? [] },
        orgs,
      });
      for (const h of held) {
        if (found.has(h.id)) continue;
        found.set(h.id, {
          id: h.id,
          name: h.connection.name,
          type: connectionType(h.connection.type).label,
          description: h.connection.description ?? "",
          use: useLine(h),
        });
      }
    }
    return [...found.values()];
  }

  /**
   * Rewrites TASK.md of each task so its Related tasks and Team facts sections are current. Facts
   * are the last ones read; only a task without any gets a fresh read.
   */
  async refreshBriefs(ids: readonly string[]): Promise<void> {
    const sections = await this.deps.config.sections();
    const stored = await this.deps.agents.list();
    const agents = stored.flatMap((a) => (a.ok ? [a.agent.frontmatter] : []));
    for (const id of new Set(ids)) {
      const task = this.deps.store.tasks.get(id);
      if (task === undefined) continue;
      const team = briefTeam(task, agents);
      const md = renderTaskMd(
        task,
        team[0],
        sections.orgs[task.org ?? ""]?.name,
        this.relatedOf(task),
        team,
        await this.knownFacts(task),
        this.deps.memory?.recalledText(task.id),
        await this.readableProjects(task),
        await this.briefConnections(task, agents),
      );
      // The folder can be gone by hand; the links still stand.
      await writeFileAtomic(join(task.folder, "TASK.md"), md).catch(() => undefined);
    }
  }

  /**
   * Before a prompt goes to the lead of a task the facts apply to: rewrites TASK.md with fresh
   * team facts and returns a short block for the prompt when they changed since the last one this
   * agent got. A `brief` prompt makes the agent read TASK.md, so it only records the block.
   */
  async beforePrompt(turn: { task: string; agent: string; brief: boolean }): Promise<string | undefined> {
    try {
      const task = this.deps.store.tasks.get(turn.task);
      if (task === undefined || task.team[0] !== turn.agent) return undefined;
      if (isOwnerChat(task)) return await this.chatMemoryBlock(task);
      const facts = await this.readFacts(task);
      if (facts === undefined) return undefined;
      await this.refreshBriefs([task.id]);
      const block = wakeFacts(facts);
      const key = `${turn.task}:${turn.agent}`;
      const same = this.wakeSeen.get(key) === block;
      this.wakeSeen.set(key, block);
      return turn.brief || same ? undefined : block;
    } catch {
      // Facts never stop a turn.
      return undefined;
    }
  }

  /**
   * The memory of a project the chat has just named or read, as a block for the next prompt: sent
   * when the set of projects changes. Capped like the Memory section of TASK.md, which it also updates.
   */
  private async chatMemoryBlock(task: Task): Promise<string | undefined> {
    const { memory, memoryScopes } = this.deps;
    if (memory === undefined || memoryScopes === undefined) return undefined;
    const scopes = await memoryScopes.recall(task.id);
    if (scopes === undefined) return undefined;
    const key = `${task.id}:${[...scopes].sort().join(",")}`;
    const before = this.chatRecallSeen.get(task.id);
    this.chatRecallSeen.set(task.id, key);
    if (before === key) return undefined;
    await memory.recall(task, scopes);
    await this.refreshBriefs([task.id]);
    const text = memory.recalledText(task.id).trim();
    // The first prompt of a chat has TASK.md already; later ones need the block.
    return before === undefined || text === "" ? undefined : `## Memory\n\n${text}`;
  }

  private relatedOf(task: Task): Related {
    const { store } = this.deps;
    const rel = (id: string): RelatedTask | undefined => {
      const t = store.tasks.get(id);
      return t === undefined
        ? undefined
        : {
            id,
            title: t.title,
            status: t.status,
            branches: t.repos.map((r) => r.branch),
          };
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

  /**
   * Forgets the ship waiting for the lead, saying why in the room, and returns it. Undefined when
   * none was waiting.
   */
  dropPendingShip(id: string, why: string): PendingShip | undefined {
    const pending = this.deps.store.tasks.takePendingShip(id);
    if (pending === undefined) return undefined;
    this.note(id as TaskId, `majhi will not ${shipWords(pending)}: ${why}.`);
    this.deps.room.publishTask(this.get(id));
    this.deps.events.emit(["tasks"]);
    return pending;
  }

  /** Every open subtask of the parent waits for the parent alone, so the parent is the one to move. */
  private childrenWaitOnParent(parent: string): boolean {
    const { tasks } = this.deps.store;
    return childrenWaitOnParent(
      parent,
      tasks.children(parent).flatMap((id) => {
        const child = tasks.get(id);
        return child === undefined ? [] : [{ status: child.status, unmet: tasks.unmetDependencies(id) }];
      }),
    );
  }

  /** An ask, choice, approval or permission card of the task still waits for the owner. */
  private ownerAnswerPending(id: string): boolean {
    this.deps.room.flush(id);
    const rooms = this.deps.store.room;
    return (["ask", "choice", "approval", "permission"] as const).some(
      (type) => rooms.pendingOfType(id, type).length > 0,
    );
  }

  /** The task only waits: its services stop, except ones whose data has no named volume to survive in. */
  private async parkServices(id: TaskId): Promise<void> {
    const { kept } = (await this.deps.containers?.taskPaused(id, { keepUnsaved: true })) ?? { kept: [] };
    if (kept.length > 0) {
      this.note(
        id,
        `${kept.join(", ")} kept running while ${id} waits: its data has no named volume, so stopping would lose it. Start it with a volume to let majhi stop it.`,
      );
    }
  }

  private note(task: TaskId, text: string): void {
    this.deps.room.post(task, `info:${randomUUID()}`, {
      type: "system",
      level: "info",
      text,
    });
  }

  // ---------------------------------------------------------------------------
  // Room

  /**
   * An agent finished its turn with nothing queued. When no agent in the task is still working,
   * the task moves to review: the owner replies (back to running) or marks it done.
   */
  async agentsIdle(id: string, refused = false): Promise<void> {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || task.status !== "running") return;
    // The captain chat is an ongoing conversation, never a piece of work to review.
    if (isBossChat(task)) {
      this.deps.onChatTurn?.(id);
      return;
    }
    // The model's safeguards stopped the last step: the task is not finished. The idle watch hands
    // the step to the lead, or to the owner.
    if (refused) return;
    if (this.deps.runs.working(id).length > 0) return;
    // An agent's question to the owner is still open: the task is not ready for review. Answering
    // it wakes the agent, and the task reaches review when the agents are idle again.
    if (this.ownerAnswerPending(id)) return;
    // A parent whose subtasks are not all done is not finished: its lead is told as they finish.
    // Unless the only ones left wait for the parent itself: then only its review lets them start.
    if (
      this.deps.store.tasks.children(id).length > 0 &&
      !this.deps.store.tasks.childrenDone(id) &&
      !this.childrenWaitOnParent(id)
    )
      return;
    // An agent waits for a background process: it is woken when that ends (5.15).
    const waiting = this.deps.processes?.waiting(id) ?? [];
    if (waiting.length > 0) {
      const fresh = waiting.filter((p) => !this.waitNoted.has(`${id} ${p.id} ${p.startedAt}`));
      for (const p of fresh) this.waitNoted.add(`${id} ${p.id} ${p.startedAt}`);
      if (fresh.length > 0) {
        this.note(id, `Waiting for ${waiting.map((p) => `${p.id} \`${p.name}\``).join(", ")}.`);
      }
      return;
    }
    this.deps.store.tasks.setStatus(id, "review", undefined, this.now().toISOString());
    await this.parkServices(id as TaskId);
    const reviewed = this.get(id);
    this.cards.review(reviewed);
    this.deps.room.publishTask(reviewed);
    this.deps.events.emit(["tasks"]);
    await this.statusChanged(id);
    await this.deps
      .onReview?.(id)
      .catch((err: unknown) => this.warn(id, `Could not ship: ${errorMessage(err)}`));
  }

  /**
   * A background process ended (5.15). A `wait` process that exited by itself wakes the agent that
   * started it, once, and a task in review runs again. Not when a newer run of the same command
   * started after it: that one's result counts, and the room only notes the old end. Nor when the
   * agent already read the end with `output` or `list`. Any other end of a `wait` process may leave
   * nobody working: the task may be ready for review.
   */
  async processEnded(p: ProcessInfo, wakes: boolean): Promise<void> {
    this.waitNoted.delete(`${p.task} ${p.id} ${p.startedAt}`);
    const task = this.deps.store.tasks.get(p.task);
    if (task === undefined) return;
    if (!wakes) {
      // The task itself stopped it (stop, close, remove, a team change): the caller sets the status.
      if (p.wait && p.stoppedBy !== "task") await this.agentsIdle(p.task);
      return;
    }
    // Stored under an id of its own: an end reported again (a replay, a restart) wakes nobody.
    const itemId = endItemId(p);
    if (this.deps.room.get(task.id, itemId) !== undefined) return;
    const newer = supersededBy(p, this.deps.processes?.list(task.id) ?? []);
    if (newer !== undefined) {
      this.deps.room.post(task.id, itemId, {
        type: "system",
        level: "info",
        text: `${p.id} \`${p.name}\` ended, but ${newer.id} is a newer run of it, so nobody is woken.`,
      });
      await this.agentsIdle(p.task);
      return;
    }
    if (this.deps.processes?.readAfterEnd(p) === true) {
      this.deps.room.post(task.id, itemId, {
        type: "system",
        level: "info",
        text: `${p.id} \`${p.name}\` ended; @${p.agent} already read it, so nobody is woken.`,
      });
      await this.agentsIdle(p.task);
      return;
    }
    if (!task.team.includes(p.agent)) return;
    if (task.status !== "running" && task.status !== "review" && task.status !== "paused") return;
    if (task.status === "paused" && waitsForOwner(task.pausedReason)) return;
    if (task.status === "review") {
      this.deps.store.tasks.setStatus(task.id, "running", undefined, this.now().toISOString());
      this.cards.settle(task.id, "review", `${p.id} ended, so @${p.agent} works on`, "majhi");
      this.deps.room.publishTask(this.get(task.id));
      this.deps.events.emit(["tasks"]);
      await this.containersRunAgain(task.id);
      await this.statusChanged(task.id);
    }
    this.deps.room.post(task.id, itemId, {
      type: "system",
      level: "info",
      text: `${p.id} \`${p.name}\` ended. Waking @${p.agent}.`,
    });
    this.deps.runs.processEnded(p);
  }

  /**
   * An agent paused on its own (offline, or an error it cannot get past), or autonomous mode's gate
   * held it (`owner`, `limit`): a running task pauses with it.
   */
  async pausedByRuns(
    id: string,
    reason: "offline" | "error" | "limit" | "owner" | "signed-out",
    why?: string,
  ): Promise<void> {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || (task.status !== "running" && task.status !== "review")) return;
    // Offline resumes by itself and the lead works on, so its ship still waits. An error does not.
    if (reason === "error" || reason === "signed-out")
      this.dropPendingShip(id, "the agent stopped with an error");
    this.deps.store.tasks.setStatus(id, "paused", reason, this.now().toISOString());
    await this.parkServices(id as TaskId);
    const paused = this.get(id);
    this.cards.paused(paused, reason, why);
    this.deps.room.publishTask(paused);
    await this.statusChanged(id);
  }

  /** A paused agent resumes by itself: a task majhi paused runs again. Tasks the owner stopped stay stopped. */
  async resumedByRuns(id: string): Promise<void> {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || task.status !== "paused" || waitsForOwner(task.pausedReason)) return;
    this.deps.store.tasks.setStatus(id, "running", undefined, this.now().toISOString());
    this.cards.settle(id, "paused", "Resumed by itself", "majhi");
    this.deps.room.publishTask(this.get(id));
    await this.containersRunAgain(id);
    await this.statusChanged(id);
  }

  /** The task runs again: its services and preview that stopped with it start again, with one line in the room. */
  private async containersRunAgain(id: string): Promise<void> {
    const containers = this.deps.containers;
    if (containers === undefined) return;
    try {
      const { started, failed } = await containers.taskRunning(id);
      if (started.length > 0) this.note(id as TaskId, `Started ${started.join(", ")} again.`);
      if (failed.length > 0) this.warn(id, `Did not start again: ${failed.join("; ")}`);
    } catch (err) {
      this.warn(id, `Services did not start again: ${errorMessage(err)}`);
    }
  }

  /** "Fresh session" on an agent in the room (5.13). */
  fresh(id: string, agent: string | undefined): Promise<RoomItem> {
    const task = this.get(id);
    const target = agent ?? task.team[0];
    if (target === undefined) throw new UserError(`Task ${id} has no agent.`, 409);
    if (!task.team.includes(target)) throw new UserError(`@${target} is not on this task.`);
    return this.deps.runs.fresh(task, target);
  }

  /** The folder and org a caller may attach files from, or undefined for the owner's own calls. */
  private attachSource(from: string | undefined): AttachSource | undefined {
    const task = from === undefined ? undefined : this.deps.store.tasks.get(from);
    return task === undefined ? undefined : { task: task.id, folder: task.folder, org: task.org };
  }

  /**
   * Checks `attachments` the way creating a task or sending a message will, without changing
   * anything. `from` is the task of the agent that asked. The approval path calls it before a card
   * is posted, so a bad entry fails at once and not after the owner approved. The target org is
   * checked when the command runs.
   */
  async checkAttachments(entries: readonly string[], from: string | undefined): Promise<void> {
    if (entries.length === 0) return;
    await planAttachments(this.deps.uploads, entries, this.attachSource(from), undefined);
  }

  /** `uploads.create`: copies a file from the caller's task folder into the upload store. */
  async uploadFile(path: string, from: string | undefined): Promise<Attachment> {
    const source = this.attachSource(from);
    if (source === undefined) {
      throw new UserError(
        "uploads.create is for agents: it copies a file from the agent's own task folder. The owner attaches files with the Attach button.",
      );
    }
    const file = await resolveTaskFile(source, path, false);
    const handle = await openChecked({
      kind: "path",
      entry: path,
      folder: source.folder,
      ...file,
    });
    return this.deps.uploads.saveFile({
      handle,
      name: file.name,
      org: source.org,
    });
  }

  async send(input: {
    task: string;
    text: string;
    attachments: string[];
    /** The task of the agent that asked. Only it lets `attachments` hold paths. */
    from?: string | undefined;
    mode: "queue" | "interrupt";
    agent?: string | undefined;
  }): Promise<RoomItem> {
    let task = this.get(input.task);
    if (input.text.trim() === "" && input.attachments.length === 0)
      throw new UserError("Write a message or attach a file.");
    // Writing in a finished chat continues it. Other tasks stay done until the owner reopens them.
    if (task.status === "done" && isOwnerChat(task)) task = await this.reopen(task.id);
    if (task.status === "done") throw new UserError(`Task ${task.id} is done.`, 409);
    const named = await this.ownerTargets(task, input.text, input.agent);
    // An agent whose account needs a new sign-in would only fail: the owner is told, and it gets nothing.
    const signedOut = new Map<string, string>();
    for (const m of named) {
      const account = await this.deps.accounts.signedOutAccountOf(m);
      if (account !== undefined) signedOut.set(m, account);
    }
    const targets = named.filter((m) => !signedOut.has(m));
    const agent = targets[0] ?? named[0];
    if (agent === undefined) throw new UserError(`Task ${task.id} has no agent.`, 409);
    // A task that cannot start says so now, before the message is stored.
    const starts = task.status !== "running";
    if (starts) this.checkStartable(task);
    this.nameChat(task, input.text);
    const planned = await planAttachments(
      this.deps.uploads,
      input.attachments,
      this.attachSource(input.from),
      { org: task.org },
    );
    const attachments = await takePlanned(this.deps.uploads, planned, join(task.folder, "attachments"));
    if (attachments.length > 0) this.deps.store.tasks.addAttachments(task.id, attachments);
    // The owner wrote back: a review card and plain-text questions stop waiting.
    this.cards.settle(task.id, "review", `Replied to @${agent}`, "owner");
    this.cards.replied(task.id);
    // The owner spoke: the loop guard counts agent turns from here.
    const state = this.deps.store.tasks.roomState(task.id);
    if (state.agentTurns > 0 || state.nudged === true)
      this.deps.store.tasks.setRoomState(task.id, {
        ...state,
        agentTurns: 0,
        nudged: false,
      });
    // A task that was never started gets its brief before this message, in the room and in the queue.
    if (starts) {
      const first = await this.firstAgents(task);
      for (const [i, a] of first.entries()) this.deps.runs.queueBrief(task, a, { ownBrief: i > 0 });
    }
    // The message shows at once. Starting the task (worktrees, memory, the session) and sending
    // it happen in the background, after earlier messages of this task.
    const item = this.deps.runs.postOwner(task.id, agent, {
      text: input.text,
      attachments,
      mode: input.mode,
    });
    this.deps.store.tasks.touch(task.id, this.now().toISOString());
    this.deps.events.emit(["tasks"]);
    const id = task.id;
    for (const [m, account] of signedOut)
      this.warn(
        id,
        `@${m} cannot run: its account ${account} needs a new sign-in. Sign it in on the Accounts page, or write to another teammate.`,
      );
    if (targets.length === 0) return item;
    this.deps.runs.inOrder(id, async () => {
      try {
        await this.deliver(id, item.id, targets, input, attachments.length > 0);
      } catch (err) {
        this.warn(id, `Your message did not reach @${agent}: ${errorMessage(err)}`);
      }
    });
    return item;
  }

  /** The slow half of `send`: joins mentioned agents, starts the task when needed, then queues the message. */
  private async deliver(
    id: string,
    itemId: string,
    targets: readonly string[],
    input: { text: string; mode: "queue" | "interrupt" },
    attached: boolean,
  ): Promise<void> {
    const [agent, ...also] = targets;
    if (agent === undefined) return;
    for (const m of targets) {
      if (!this.get(id).team.includes(m)) await this.addToTeam(id, m);
    }
    if (attached) {
      // TASK.md lists them, so every agent in the task can find the files.
      await this.refreshBriefs([id]);
      this.deps.room.publishTask(this.get(id));
    }
    await this.grantMentionedReads(this.get(id), targets, input.text);
    const task = this.get(id);
    if (task.status === "done") throw new UserError(`Task ${id} is done.`, 409);
    // A task that was never started, or was stopped, starts with the message.
    if (task.status !== "running") await this.start(id);
    await this.deps.runs.deliver(task.id, agent, itemId, input.mode, also);
    this.deps.events.emit(["tasks"]);
  }

  /**
   * The owner answered an agent's request outside the message box (an approval card, a secret).
   * The agent gets `text`, with whatever detail it needs; the room gets no owner message, so the
   * caller posts its own plain line. Like a message, it wakes the task.
   */
  async tellAgent(input: {
    task: string;
    agent: string;
    text: string;
    settled: string;
    /** Who answered: `owner` (default), the captain's agent id, or `majhi`. */
    by?: string;
  }): Promise<void> {
    const task = this.get(input.task);
    if (task.status === "done") throw new UserError(`Task ${task.id} is done.`, 409);
    if (!task.team.includes(input.agent)) throw new UserError(`@${input.agent} is not on this task.`);
    this.cards.settle(task.id, "review", input.settled, input.by ?? "owner");
    if (task.status !== "running") await this.start(task.id);
    const state = this.deps.store.tasks.roomState(task.id);
    if (state.agentTurns > 0 || state.nudged === true)
      this.deps.store.tasks.setRoomState(task.id, {
        ...state,
        agentTurns: 0,
        nudged: false,
      });
    this.deps.runs.notify(task.id, input.agent, input.text);
    this.deps.store.tasks.touch(task.id, this.now().toISOString());
    this.deps.events.emit(["tasks"]);
  }

  /**
   * A message from a schedule or trigger to the task's lead. Like an owner message it wakes the
   * task, but the room shows a plain line saying where it came from, not an owner message.
   */
  async postFromScheduler(input: { task: string; text: string; from: string }): Promise<void> {
    const task = this.get(input.task);
    if (task.status === "done") throw new UserError(`Task ${task.id} is done.`, 409);
    const lead = task.team[0];
    if (lead === undefined) throw new UserError(`Task ${task.id} has no agent.`, 409);
    this.note(task.id, `Message from scheduler "${input.from}" to @${lead}: ${input.text}`);
    this.cards.settle(task.id, "review", `Message from scheduler "${input.from}"`, "majhi");
    // A schedule is not the owner: it resumes no pause of a budget or of autonomous mode by hand.
    if (task.status !== "running") await this.start(task.id, "majhi");
    this.deps.runs.notify(task.id, lead, `Scheduled message from "${input.from}": ${input.text}`);
    this.deps.store.tasks.touch(task.id, this.now().toISOString());
    this.deps.events.emit(["tasks"]);
  }

  /**
   * The captain writes to an agent of a running task (SPEC 5.18, `tasks.tell`). The room shows a
   * note from the Captain, and the agent is woken like by an owner message, but the task is not
   * restarted or stopped, its brief is not edited, and the text is advice: it grants no approval.
   * A task that is paused, done or not started is not written to; the owner or `tasks.start` moves it.
   */
  async captainTell(input: {
    task: string;
    agent?: string | undefined;
    text: string;
    /** The captain's agent id. */
    by: string;
  }): Promise<{ id: string; agent: string }> {
    const task = this.get(input.task);
    if (task.status !== "running" && task.status !== "review") {
      throw new UserError(`${task.id} is ${task.status}, so there is no lead working to tell.`, 409);
    }
    const agent = input.agent ?? task.team[0];
    if (agent === undefined) throw new UserError(`${task.id} has no agent.`, 409);
    if (!task.team.includes(agent)) throw new UserError(`@${agent} is not on ${task.id}.`, 409);
    this.note(task.id, `Captain to @${agent}: ${input.text}`);
    await this.tellAgent({
      task: task.id,
      agent,
      text: `Message from the captain (it is advice, not the owner's approval; the owner's rules and checks still decide what you may do):\n${input.text}`,
      settled: "The captain wrote to the lead",
      by: input.by,
    });
    return { id: task.id, agent };
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
    // Checked now so a mention that cannot join fails the send; `deliver` adds them.
    for (const m of mentioned) {
      if (!task.team.includes(m)) await this.checkMember(task, m);
    }
    if (mentioned.length > 0) return mentioned;
    const lead = task.team[0];
    return lead === undefined ? [] : [lead];
  }

  async cancel(id: string, agent: string | undefined): Promise<string[]> {
    this.get(id);
    return this.deps.runs.cancel(id, agent);
  }

  /** The owner's answer to a permission prompt, or the captain's (`captain`: its agent id). */
  answerPermission(id: string, item: string, option: string, captain?: string): RoomItem {
    this.get(id);
    const answered = this.deps.runs.answerPermission(id, item, option, captain !== undefined);
    if (captain === undefined) this.deps.onOwnerPermission?.(id, answered);
    return answered;
  }

  items(id: string, limit: number, beforeSeq: number | undefined, afterSeq?: number) {
    this.get(id);
    this.deps.room.flush(id);
    if (afterSeq !== undefined) return this.deps.store.room.pageAfter(id, limit, afterSeq);
    return this.deps.store.room.page(id, limit, beforeSeq);
  }

  /** The page around one item, for a search match far back in a long room. */
  itemsAround(id: string, item: string, limit: number) {
    this.get(id);
    this.deps.room.flush(id);
    const page = this.deps.store.room.around(id, item, Math.ceil(limit / 2));
    return page ?? { items: [], older: false, newer: false };
  }

  /** Full-text search over every task's room. Items still in the room's write buffer show up once it flushes. */
  searchRooms(query: string, limit: number, org: string | undefined): RoomSearchHit[] {
    return this.deps.store.room.search(query, limit, org);
  }

  searchFiles(id: string, query: string): Promise<FileHit[]> {
    return this.files.search(this.get(id), query);
  }

  private warn(task: Task["id"], text: string): void {
    this.deps.room.post(task, `warn:${randomUUID()}`, {
      type: "system",
      level: "warn",
      text,
    });
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

/** The review card's Mark done: allowed or why not, and the work that would stay behind. */
type DoneOption = ShipOptions["done"];

async function headOf(worktree: string): Promise<string> {
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

async function branchExists(source: string, branch: string): Promise<boolean> {
  if (await localBranchExists(source, branch)) return true;
  const remote = await remoteOf(source).catch(() => undefined);
  return remote !== undefined && (await remoteBranchExists(source, remote, branch));
}

/** What a clean merge did, for the room and the Ship panel. */
function mergedDetail(
  branch: string,
  into: string,
  how: Exclude<MergeOutcome, { ok: false }>["how"],
): string {
  switch (how) {
    case "already merged":
      return `${branch} is already in ${into}.`;
    case "squash commit":
      return `Squashed ${branch} into one commit on ${into}. Not pushed.`;
    case "rebased":
      return `Rebased ${branch} onto ${into} and moved ${into} forward. Not pushed.`;
    default:
      return `Merged ${branch} into ${into} (${how}). Not pushed.`;
  }
}

/** Uncommitted changes, one line per file: `<worktree folder>: <git status line>`. */
function changeLines(dirty: readonly { path: string; changes: string[] }[]): string[] {
  return dirty.flatMap((d) => d.changes.map((c) => `${basename(d.path)}: ${c}`));
}

/** At most this many changed files in a refusal. */
const DISCARD_LIST_MAX = 200;

/** A 409 that lists every uncommitted change a forced removal would delete. */
function discardRefusal(message: string, dirty: readonly { path: string; changes: string[] }[]): UserError {
  const lines = changeLines(dirty);
  const shown =
    lines.length > DISCARD_LIST_MAX
      ? [...lines.slice(0, DISCARD_LIST_MAX), `and ${lines.length - DISCARD_LIST_MAX} more`]
      : lines;
  return new UserError(message, 409, shown);
}
