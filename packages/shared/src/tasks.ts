import { z } from "zod";
import { BranchPatternSchema, IdSchema, MrHostSchema, OrgIdSchema, SecretRefSchema } from "./accounts.ts";
import { DiagramSpecSchema } from "./diagram.ts";
import { ProcessInfoSchema } from "./processes.ts";
import { CoordinationModeSchema, HandoffViaSchema, TeamOverrideSchema } from "./rooms.ts";
import { CommitsPatchSchema } from "./settings.ts";
import { SkillNameSchema } from "./skills.ts";
import { DaySchema } from "./usage.ts";

/**
 * Projects, tasks, rooms and runs (SPEC 2, 3.1, 5.1, 5.4, 5.4a, 5.15).
 *
 * Files on disk:
 *   ~/.majhi/majhi.yaml           `projects:` section
 *   ~/.majhi/majhi.db             tasks, task repos, task links, room items, runs (SQLite, WAL)
 *   <tasks_dir>/<task-id>/        TASK.md, AGENTS.md, CLAUDE.md, attachments/, one worktree per repo
 */

// ---------------------------------------------------------------------------
// Projects (majhi.yaml)

/** One git remote of a project, as majhi.yaml describes it (5.5). */
export const RemoteConfigSchema = z.looseObject({
  /** Which host this remote is. Default: read from the remote's URL. */
  host: MrHostSchema.optional(),
  /** A `Host` in ~/.ssh/config. Pushes go through it, whatever host name the remote URL holds. */
  ssh: z.string().trim().min(1).optional(),
  /** True on the remote MRs are opened against. Default: `origin`. */
  mr: z.boolean().optional(),
  /** Credentials for this remote's host: overrides the org's `mr_tokens`. */
  token: SecretRefSchema.optional(),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

/** `depends-on`: the other project merges first when a task changes both (5.5). */
export const ProjectLinkSchema = z.object({
  to: IdSchema,
  type: z.literal("depends-on"),
});
export type ProjectLink = z.infer<typeof ProjectLinkSchema>;

/**
 * The shell lines the hand-off check runs for a project instead of the ones its card read from the
 * repo. `test` may hold `{base}`: majhi swaps in the merge-base commit of the task branch and its
 * target (a sha it computed), so a project can test only what the task changed.
 */
export const HandoffCommandsSchema = z.object({
  install: z.string().trim().min(1).optional(),
  test: z.string().trim().min(1).optional(),
  build: z.string().trim().min(1).optional(),
  lint: z.string().trim().min(1).optional(),
  typecheck: z.string().trim().min(1).optional(),
});
export type HandoffCommands = z.infer<typeof HandoffCommandsSchema>;

export const ProjectConfigSchema = z.looseObject({
  /** An org id from `orgs`, or `private`. */
  org: OrgIdSchema,
  /** Absolute path, or one starting with `~/`, under a workspace root. */
  path: z.string().trim().min(1),
  /** Words that name this project in the task box: "api", "backend". Lowercase, unique across projects. */
  aliases: z.array(z.string().trim().toLowerCase().min(1)).default([]),
  /** Base branch for tasks. Default: the org's `base`, then the repo's default branch. */
  base: z.string().trim().min(1).optional(),
  /** Git remotes by name, with the host, SSH alias and which one takes MRs. */
  remotes: z.record(z.string().trim().min(1), RemoteConfigSchema).optional(),
  /** Other projects this one depends on. Sets the merge order of a multi-repo task. */
  links: z.array(ProjectLinkSchema).optional(),
  /** Overrides the org's and majhi's `commits.attribution` for this project (5.7). */
  commits: CommitsPatchSchema.optional(),
  /** How new task branches are named here. Overrides the org's, and what the repo's branches show. */
  branch_pattern: BranchPatternSchema.optional(),
  /**
   * Infra or otherwise sensitive (gitops, terraform, deploy). majhi never adds it to a task by
   * itself, agents get it read-only unless the owner allows writes for a task, and it ships only
   * alone, when the owner types its name.
   */
  protected: z.boolean().optional(),
  /** Hand-off check commands that win over the project card's. */
  handoff: HandoffCommandsSchema.optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const ProjectViewSchema = z.object({
  id: IdSchema,
  org: IdSchema,
  /** Absolute path. */
  path: z.string(),
  aliases: z.array(z.string()),
  /** Resolved base branch (project, then org, then the repo's default branch). */
  base: z.string().optional(),
  /** False when the path is not a git repo the server can see. */
  exists: z.boolean(),
  remotes: z.record(z.string(), RemoteConfigSchema).default({}),
  links: z.array(ProjectLinkSchema).default([]),
  /** The remote MRs are opened against: the one marked `mr`, else `origin`. */
  mrRemote: z.string().optional(),
  /** This project's own `commits.attribution`, when it overrides the org's. */
  commits: CommitsPatchSchema.optional(),
  /** See ProjectConfig.protected. */
  protected: z.boolean().default(false),
  /** This project's own hand-off check commands, when set. */
  handoff: HandoffCommandsSchema.optional(),
  /** Not protected, but looks like infra by its name or files: the UI offers to protect it. */
  looksLikeInfra: z.boolean().optional(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

// ---------------------------------------------------------------------------
// Tasks

/** `GLX-420`, `LOCAL-9`. The org's key prefix plus a number. Also the task folder name. */
export const TaskIdSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]*$/, "Task ids look like GLX-420");
export type TaskId = z.infer<typeof TaskIdSchema>;

/** Prefix for tasks without an org. */
export const LOCAL_TASK_PREFIX = "LOCAL";

export const TaskKindSchema = z.enum(["code", "ops", "chat"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskStatusSchema = z.enum(["inbox", "ready", "running", "paused", "review", "mr", "done"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** The owner's priority for a task (PRV-74). Absent means normal. Autonomous mode takes high first. */
export const TaskPrioritySchema = z.enum(["high", "normal", "low"]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * Why a task is paused. `owner`: you stopped it. `loop`: majhi's loop guard paused agents going in
 * circles. `blocked`: a task it waits on changed. owner, loop and blocked wait for you to continue.
 * `signed-out`: no agent could start because its account is signed out; it resumes by itself once
 * the account is healthy again. An account at its limit, or any other failed start, pauses as `error`.
 */
export const PausedReasonSchema = z.enum([
  "limit",
  "offline",
  "error",
  "owner",
  "loop",
  "blocked",
  "signed-out",
]);
export type PausedReason = z.infer<typeof PausedReasonSchema>;

/**
 * Who paused a task, when it was not the owner by hand: the captain, or Autonomous being turned off.
 * Absent on older rows and on pauses by majhi itself (limits, going offline).
 */
/** Where the owner fixes what blocks a Ship action: a project's remotes, or an org's settings. */
export const ShipFixSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("projects"), project: IdSchema }),
  z.object({ page: z.literal("orgs"), org: IdSchema }),
]);
export type ShipFix = z.infer<typeof ShipFixSchema>;

export const PausedBySchema = z.enum(["captain", "autonomy-off"]);
export type PausedBy = z.infer<typeof PausedBySchema>;

/** Paused until the owner continues it: never resumed by majhi on its own. */
export function waitsForOwner(reason: PausedReason | undefined): boolean {
  return reason === "owner" || reason === "loop" || reason === "blocked";
}

export const MrStateSchema = z.enum(["open", "merged", "closed"]);
export type MrState = z.infer<typeof MrStateSchema>;

/** `none`: the host reports no checks, which is not the same as passing (5.5). */
export const CiStateSchema = z.enum(["none", "pending", "passing", "failing"]);
export type CiState = z.infer<typeof CiStateSchema>;

/** How a merge lands the task branch: a merge commit, one squashed commit, or a rebase and fast-forward. */
export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

/**
 * A ship that stopped on conflicts, which majhi finishes once the lead has resolved them (the
 * owner's "Resolve and merge" click). Run at most once: majhi clears it before it runs the ship,
 * and when the lead stops without clean work.
 */
export const PendingShipSchema = z.object({
  action: z.enum(["merge", "mergePush"]),
  /** The local branch to merge into, or the targets joined for display when `targets` is set. */
  into: z.string(),
  /** The branch each repo merges into, by project. */
  targets: z.record(z.string(), z.string()).optional(),
  /** The commit each target was at when the ship was asked for, by project: a target that moved since is not shipped onto. */
  heads: z.record(z.string(), z.string()).optional(),
  method: MergeMethodSchema,
  deleteAfter: z.boolean(),
  /** The agent asked to resolve the conflicts. */
  lead: IdSchema,
  requestedAt: z.string(),
  by: z.string(),
});
export type PendingShip = z.infer<typeof PendingShipSchema>;

/** What a ship does, in a few words: "merge into main", "squash and push main", "rebase onto dev". */
export function shipWords(ship: Pick<PendingShip, "action" | "into" | "method">): string {
  if (ship.action === "mergePush") return `${ship.method} and push ${ship.into}`;
  return ship.method === "rebase" ? `rebase onto ${ship.into}` : `${ship.method} into ${ship.into}`;
}

/**
 * "Merge when checks pass": the owner's click in Ship while the hand-off check runs. majhi merges by
 * itself when the check of exactly `head` is green, through the normal merge path, and cancels it
 * (never merging) when the head moved, a check failed or the merge refuses. One per task.
 */
export const QueuedMergeSchema = z.object({
  task: z.string().min(1),
  action: z.enum(["merge", "mergePush"]),
  /** The local branch to merge into, or the targets joined for display when `targets` is set. */
  into: z.string(),
  /** The branch each repo merges into, by project. */
  targets: z.record(z.string(), z.string()).optional(),
  method: MergeMethodSchema,
  deleteAfter: z.boolean(),
  /** The task's head commits when asked (`project@sha`, per repo): only this exact state merges. */
  head: z.string().min(1),
  by: z.string(),
  at: z.string(),
});
export type QueuedMerge = z.infer<typeof QueuedMergeSchema>;

/** What the host says about the reviews of a merge request. */
export const MrReviewSchema = z.object({
  /** Enough approvals, or the host counts it approved. */
  approved: z.boolean(),
  /** Reviewers whose latest review approves it. */
  approvals: z.number().int().nonnegative(),
  /** Approvals still missing, when the host says (GitLab). */
  approvalsNeeded: z.number().int().nonnegative().optional(),
  /** A reviewer asked for changes (GitLab: a blocking discussion is unresolved). */
  changesRequested: z.boolean(),
  /** Reviewers asked to review who have not yet. Names the host shows. */
  pending: z.array(z.string()).max(30).default([]),
});
export type MrReview = z.infer<typeof MrReviewSchema>;

/** One short line for a card: "approved", "changes requested", "1 of 2 approvals", "waiting on ana". */
export function reviewLine(review: MrReview | undefined): string | undefined {
  if (review === undefined) return undefined;
  if (review.changesRequested) return "changes requested";
  if (review.approved) return review.approvals > 0 ? `approved by ${review.approvals}` : "approved";
  if (review.approvalsNeeded !== undefined && review.approvalsNeeded > 0)
    return `${review.approvals} of ${review.approvals + review.approvalsNeeded} approvals`;
  if (review.pending.length > 0) return `waiting on ${review.pending.slice(0, 2).join(", ")}`;
  return undefined;
}

/** The merge request of one task repo. */
export const RepoMrSchema = z.object({
  url: z.string(),
  number: z.number().int().positive(),
  state: MrStateSchema,
  ci: CiStateSchema,
  /** Absent until a poll read the reviews, or when the host does not say. */
  review: MrReviewSchema.optional(),
});
export type RepoMr = z.infer<typeof RepoMrSchema>;

export const TaskRepoSchema = z.object({
  project: IdSchema,
  /** The project's own checkout, where the worktree is added from. */
  source: z.string(),
  base: z.string(),
  branch: z.string(),
  /** `<tasks_dir>/<task-id>/<project>`. Absent until the worktree exists. */
  worktree: z.string().optional(),
  /** True when majhi created the branch; false when the owner named an existing one. */
  createdBranch: z.boolean(),
  /**
   * Set when the branch is stacked on a `ready` dependency's working branch (5.4a): that task,
   * its branch, and the commit of it this branch sits on now. majhi rebases when it moves.
   */
  stack: z.object({ task: TaskIdSchema, branch: z.string(), commit: z.string() }).optional(),
  /** The owner's place for this repo in the merge order (0 first). All repos carry one, or none. */
  mergeOrder: z.number().int().nonnegative().optional(),
  /** When the branch was last pushed for an MR. */
  pushedAt: z.string().optional(),
  /** The branch tip majhi itself merged, and the branch it went into. Squash merges keep no commits. */
  shipped: z.object({ head: z.string(), into: z.string() }).optional(),
  /** The commit majhi cut the branch from. Absent on older tasks and on branches the owner named. */
  startCommit: z.string().optional(),
  /** A protected project the owner let agents write in, for this task. Else agents get it read-only. */
  writes: z.boolean().optional(),
  /** Set once the MR is open. */
  mr: RepoMrSchema.optional(),
});
export type TaskRepo = z.infer<typeof TaskRepoSchema>;

export const TaskLinkTypeSchema = z.enum(["parent", "depends-on", "follow-up"]);
export const TaskLinkSchema = z.object({
  type: TaskLinkTypeSchema,
  /** The other task. For `parent`, the parent. */
  task: TaskIdSchema,
  /** For `depends-on`: when the dependency counts as met (5.4a). */
  when: z.enum(["merged", "ready"]).optional(),
});
export type TaskLink = z.infer<typeof TaskLinkSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "file", "link"]),
  /** File name, or the link's title. */
  name: z.string(),
  mime: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  /** For links. */
  url: z.string().optional(),
  /** Path under the task's `attachments/`. */
  path: z.string().optional(),
  /** Set when fetching or converting failed. */
  error: z.string().optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** A folder or file a task's agents may read, mounted read-only. No `agent` means every agent of the task. */
export const ReadMountSchema = z.object({
  path: z.string().min(1),
  agent: IdSchema.optional(),
  at: z.string(),
});
export type ReadMount = z.infer<typeof ReadMountSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  /** One line, from the first line of the brief. */
  title: z.string(),
  /** What the owner typed, verbatim. */
  brief: z.string(),
  kind: TaskKindSchema,
  /** An org id, or absent for LOCAL tasks. */
  org: IdSchema.optional(),
  status: TaskStatusSchema,
  pausedReason: PausedReasonSchema.optional(),
  pausedBy: PausedBySchema.optional(),
  /** The owner's priority. Absent: normal. */
  priority: TaskPrioritySchema.optional(),
  /** The owner's deadline, `YYYY-MM-DD`. Within a priority, autonomous mode takes the nearest first. */
  due: DaySchema.optional(),
  /** The owner marked it Not for autonomous mode: the captain in autonomous mode leaves it alone. */
  noAutonomy: z.boolean().optional(),
  /** Absolute path of the task folder. */
  folder: z.string(),
  repos: z.array(TaskRepoSchema),
  /**
   * Folders mounted read-only into the agents' runs: ones the owner mentioned with `@/path`, and the
   * repos of an investigation task, which has no branch, worktree or Ship. Absent for none.
   */
  readMounts: z.array(ReadMountSchema).optional(),
  /**
   * Connections the task's root agents get beyond its org's (SPEC 5.14): named when it was created,
   * or attached by a root agent. Absent for none.
   */
  connections: z.array(IdSchema).optional(),
  /** Agent ids. The first is the lead: owner messages without a mention go to it. */
  team: z.array(IdSchema),
  /** How the team takes turns (5.3). */
  mode: CoordinationModeSchema,
  /** The owner's model, effort and repo choices per agent for this task. */
  overrides: z.record(IdSchema, TeamOverrideSchema),
  links: z.array(TaskLinkSchema),
  attachments: z.array(AttachmentSchema),
  /** A ship majhi runs when the lead has resolved its conflicts. */
  pendingShip: PendingShipSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Why a path given for another task's repo is refused, or undefined when it stays inside the repo:
 * relative, forward slashes, no `.` or `..` part, no empty part, and never into `.git`.
 */
export function repoPathProblem(path: string): string | undefined {
  if (path.includes("\0")) return "has a NUL byte";
  if (path.includes("\\")) return "uses a backslash; use forward slashes";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "is absolute; give it from the repo root";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === ".")) return "has an empty or . part";
  if (parts.includes("..")) return "leaves the repo (..)";
  if (parts.some((p) => p.toLowerCase() === ".git")) return "is inside .git";
  return undefined;
}

/** One file of a `tasks.changeBranch`: its path from the repo root and its whole new content. */
export const BranchFileSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .superRefine((path, ctx) => {
      const problem = repoPathProblem(path);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: `${path} ${problem}` });
    }),
  content: z.string().max(512 * 1024),
});
export type BranchFile = z.infer<typeof BranchFileSchema>;

export const ChangeBranchInputSchema = z
  .object({
    /** The task whose branch changes. */
    task: TaskIdSchema,
    /** Which repo of that task. Needed when it has more than one. */
    project: IdSchema.optional(),
    /** The commit of the target branch the caller read its files from. A branch that moved since is refused. */
    base: z
      .string()
      .trim()
      .regex(/^[0-9a-fA-F]{7,40}$/, "base is a commit: 7 to 40 hex characters"),
    /** Whole files: for new files or full rewrites. */
    files: z
      .array(BranchFileSchema)
      .min(1)
      .max(50)
      .refine((files) => new Set(files.map((f) => f.path)).size === files.length, "Each path only once")
      .optional(),
    /** A unified diff relative to the repo root: for small edits. */
    patch: z
      .string()
      .min(1)
      .max(200 * 1024)
      .optional(),
    message: z.string().trim().min(1).max(2000),
  })
  .refine((v) => (v.files === undefined) !== (v.patch === undefined), "Give exactly one of files or patch");
export type ChangeBranchInput = z.infer<typeof ChangeBranchInputSchema>;

export const ChangeBranchResultSchema = z.object({
  task: TaskIdSchema,
  project: IdSchema,
  branch: z.string(),
  commit: z.string(),
  files: z.array(z.string()),
});
export type ChangeBranchResult = z.infer<typeof ChangeBranchResultSchema>;

/** The brief of a chat the owner started from the Chats page or Cmd J. It marks the task; it is never shown. */
export const CHAT_BRIEF = "Chat";
/** The same marker on chats made before the Chats page. */
export const BOSS_CHAT_BRIEF = "Captain chat";
/** What an untitled chat is called until the owner's first message names it. */
export const DEFAULT_CHAT_TITLES: readonly string[] = [CHAT_BRIEF, BOSS_CHAT_BRIEF];
/**
 * The brief of the captain's autonomy chat (PRV-74): where autonomous mode wakes the captain and the owner
 * guides it. A chat like the others, but never the owner's Cmd J chat.
 */
export const AUTONOMY_CHAT_BRIEF = "Autonomous mode";
/**
 * The brief of a captain lane (SPEC 5.18): the captain's chat for one workspace, where its upkeep
 * and autonomous mode wake it with that workspace's matters only.
 */
export const CAPTAIN_LANE_BRIEF = "Captain lane";

/** True for a chat with an agent: an ongoing conversation, not a piece of work to review. */
export function isOwnerChat(task: Pick<Task, "kind" | "brief">): boolean {
  return (
    task.kind === "chat" &&
    (task.brief === CHAT_BRIEF ||
      task.brief === BOSS_CHAT_BRIEF ||
      task.brief === AUTONOMY_CHAT_BRIEF ||
      task.brief === CAPTAIN_LANE_BRIEF)
  );
}

/** True for the captain's autonomy chat (before Phase 13) and its lanes: never the owner's Cmd J chat. */
export function isAutonomyChat(task: Pick<Task, "kind" | "brief">): boolean {
  return task.kind === "chat" && (task.brief === AUTONOMY_CHAT_BRIEF || task.brief === CAPTAIN_LANE_BRIEF);
}

/** True for a captain lane. */
export function isCaptainLane(task: Pick<Task, "kind" | "brief">): boolean {
  return task.kind === "chat" && task.brief === CAPTAIN_LANE_BRIEF;
}

/** A chat title from the owner's first message: its first line, trimmed and cut to fit. */
export function chatTitleFrom(text: string): string | undefined {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (line === undefined) return undefined;
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}...` : line;
}

/** One row of the task list. */
export const TaskSummarySchema = TaskSchema.pick({
  id: true,
  title: true,
  kind: true,
  org: true,
  status: true,
  pausedReason: true,
  pausedBy: true,
  priority: true,
  due: true,
  noAutonomy: true,
  team: true,
  mode: true,
  updatedAt: true,
}).extend({
  /** Autonomous mode runs this task: it created, started or adopted it (PRV-74). */
  autonomous: z.boolean().optional(),
  repos: z.array(z.object({ project: IdSchema, branch: z.string() })),
  /** Agents working right now. */
  working: z.array(IdSchema),
  links: z.array(TaskLinkSchema),
  /** For parent tasks: how many children, and how many are done. */
  children: z
    .object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative() })
    .optional(),
  /** Unmet `depends-on` links: the tasks this one waits for (5.4a). */
  waitingOn: z.array(TaskIdSchema),
  /** A chat with an agent (`isOwnerChat`). Chats show in Chats, not on the board. */
  chat: z.boolean().optional(),
  /** A workspace thread of the captain (5.18): not a task to the owner, never listed by `tasks.list`. */
  lane: z.boolean().optional(),
  /**
   * The task or chat waits for the owner on an item: an approval, a permission, a secret, a question.
   * It counts under Needs you even while an agent still works. A quiet chat is shown on the board only then.
   */
  asking: z.boolean().optional(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;

/** The task list groups (SPEC 2). */
export function taskGroup(status: TaskStatus): "needs-you" | "working" | "up-next" | "done" {
  switch (status) {
    case "review":
    case "paused":
    case "mr":
      return "needs-you";
    case "running":
      return "working";
    case "inbox":
    case "ready":
      return "up-next";
    case "done":
      return "done";
  }
}

// ---------------------------------------------------------------------------
// Task box parsing (SPEC 3.1). Shared by the web (live chips) and the server
// (authoritative on create). Implemented in `task-parse.ts`.

export interface ParseContext {
  projects: readonly { id: string; org: string; aliases: readonly string[] }[];
  agents: readonly { id: string }[];
}

export const ParsedTaskSchema = z.object({
  title: z.string(),
  /** Projects matched by id or alias, in order of first mention. `match` is the text that matched. */
  repos: z.array(z.object({ project: IdSchema, match: z.string() })),
  /** `@agent-id` mentions of known agents. */
  mentions: z.array(IdSchema),
  links: z.array(z.string()),
  /** The org of the matched repos, when they agree. */
  org: IdSchema.optional(),
  kind: TaskKindSchema,
  warnings: z.array(z.string()),
});
export type ParsedTask = z.infer<typeof ParsedTaskSchema>;

// ---------------------------------------------------------------------------
// Room

const RoomItemBase = z.object({
  /** Stable id: upserts replace the item with the same id. */
  id: z.string(),
  task: TaskIdSchema,
  /** Increases with every insert or update in the task; clients keep the highest. */
  seq: z.number().int().nonnegative(),
  at: z.string(),
});

export const ToolContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().optional(),
    newText: z.string(),
  }),
  /** Terminal output, trimmed in the middle past 16 KB. */
  z.object({ type: z.literal("terminal"), output: z.string(), exitCode: z.number().int().optional() }),
]);
export type ToolContent = z.infer<typeof ToolContentSchema>;

/** Something the agent shows the owner: an image, video, audio, a page or file in the task folder, or a web link. */
export const MediaRefSchema = z.object({
  kind: z.enum(["image", "video", "audio", "file", "page", "link"]),
  name: z.string(),
  /** A task-files URL (`/api/tasks/<id>/files/<path>`) or an http(s) URL. */
  src: z.string(),
  mime: z.string().optional(),
});
export type MediaRef = z.infer<typeof MediaRefSchema>;

export const PermissionOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
});

/** How a plan gets the work done (PRV-52), for comparing plans later. */
export const PlanHowSchema = z.enum(["alone", "builders", "reviewer", "children", "parallel"]);
export type PlanHow = z.infer<typeof PlanHowSchema>;

/** The lead's plan for a task: who does what, in order, and why that is cheaper or faster. */
export const TeamPlanSchema = z.strictObject({
  /** In order. `who` is an @agent, "me", or "child tasks". */
  steps: z
    .array(z.strictObject({ who: z.string().trim().min(1).max(80), what: z.string().trim().min(1).max(300) }))
    .min(1)
    .max(8),
  /** Why this is cheaper or faster, in a line or two. */
  why: z.string().trim().min(1).max(600),
  how: z.array(PlanHowSchema).min(1).max(5),
});
export type TeamPlan = z.infer<typeof TeamPlanSchema>;

const PlanCount = z.number().int().nonnegative();

/** Tokens one agent used under a plan version. `tokens` counts input, output, cache read and cache write. */
export const PlanAgentTokensSchema = z.object({
  agent: IdSchema,
  turns: PlanCount,
  tokens: PlanCount,
  outputTokens: PlanCount,
  /** Null when none of its turns had a price. */
  costUsd: z.number().nonnegative().nullable(),
});
export type PlanAgentTokens = z.infer<typeof PlanAgentTokensSchema>;

/** What a plan version cost, read when the task reached review or done. */
export const PlanOutcomeSchema = z.object({
  at: z.string(),
  status: TaskStatusSchema,
  /** The tokens include the task's subtasks. */
  withSubtasks: z.boolean().default(false),
  agents: z.array(PlanAgentTokensSchema),
});
export type PlanOutcome = z.infer<typeof PlanOutcomeSchema>;

/** One member of the team when a plan was recorded, copied in so the history outlives the task. */
export const PlanMemberSchema = z.object({
  id: IdSchema,
  role: z.string(),
  model: z.string().optional(),
  tier: z.string().optional(),
  account: z.string(),
});
export type PlanMember = z.infer<typeof PlanMemberSchema>;

/** What happened to an owner card: one line, who did it (`owner`, an agent id or `majhi`), and when. */
export const CardOutcomeSchema = z.object({
  text: z.string(),
  by: z.string(),
  at: z.string(),
  /** The captain did it, itself or through autonomous mode: shown as "Captain" (5.18). Older outcomes lack it. */
  captain: z.literal(true).optional(),
});
export type CardOutcome = z.infer<typeof CardOutcomeSchema>;

/**
 * `pending` waits for the owner. `settled`: `outcome` says what happened. `replaced`: a newer card
 * of the same kind took its place, so it is not shown.
 */
export const CardStateSchema = z.enum(["pending", "settled", "replaced"]);
export type CardState = z.infer<typeof CardStateSchema>;

/** Actions on a review or paused card (`room.cardAction`). */
export const CardActionSchema = z.enum(["merge", "mergePush", "push", "mr", "done", "resume"]);
export type CardAction = z.infer<typeof CardActionSchema>;

/** Who did it, on a room item the owner usually answers: only ever the captain, absent for the owner. */
export const CaptainBySchema = z.literal("captain");

export const RoomItemSchema = z.discriminatedUnion("type", [
  RoomItemBase.extend({
    type: z.literal("owner"),
    text: z.string(),
    attachments: z.array(AttachmentSchema),
    /** Sent while the agent was busy: waits for its next turn. */
    queued: z.boolean(),
    /** The owner took it out of the queue before it was sent: the agent never got it. */
    removed: z.boolean().optional(),
    /** The agent it went to. */
    to: IdSchema.optional(),
  }),
  RoomItemBase.extend({
    type: z.literal("agent"),
    agent: IdSchema,
    text: z.string(),
    /** Images and links the agent sent as ACP content blocks, beside its text. */
    media: z.array(MediaRefSchema).optional(),
  }),
  RoomItemBase.extend({ type: z.literal("thought"), agent: IdSchema, text: z.string() }),
  /**
   * One agent woke another (5.3): by @mention, the pipeline's next step or the review loop. `text`
   * is the message that did it. `queued` while the target is busy; it is sent on its next turn.
   */
  RoomItemBase.extend({
    type: z.literal("handoff"),
    from: IdSchema,
    to: IdSchema,
    via: HandoffViaSchema,
    text: z.string(),
    queued: z.boolean(),
  }),
  RoomItemBase.extend({
    type: z.literal("tool"),
    agent: IdSchema,
    toolCallId: z.string(),
    title: z.string(),
    /** ACP tool kind: read, edit, delete, move, search, execute, think, fetch, other. */
    kind: z.string(),
    status: z.enum(["pending", "in_progress", "completed", "failed"]),
    locations: z.array(z.string()),
    content: z.array(ToolContentSchema),
    /** The tool call loaded this installed skill: the row reads "Used skill" and links to it. */
    skill: SkillNameSchema.optional(),
  }),
  RoomItemBase.extend({
    type: z.literal("plan"),
    agent: IdSchema,
    entries: z.array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    ),
  }),
  RoomItemBase.extend({
    type: z.literal("permission"),
    agent: IdSchema,
    title: z.string(),
    toolCallId: z.string().optional(),
    options: z.array(PermissionOptionSchema),
    state: z.enum(["pending", "answered", "auto", "cancelled"]),
    /** The option picked, by the owner (`answered`) or by the agent's permissions (`auto`). */
    chosen: z.string().optional(),
    /** Set when the captain answered it instead of the owner (5.18). Older items lack it. */
    by: CaptainBySchema.optional(),
    /**
     * A write to one of the run's connections (5.14): which one, the action and why it counts as a
     * write. No remembered choice covers it, and Allow counts once. `destructive`: it deletes or
     * destroys something, so only the owner's own click approves it.
     */
    connection: z
      .object({
        id: z.string().optional(),
        name: z.string(),
        action: z.string(),
        why: z.string(),
        destructive: z.boolean().optional(),
      })
      .optional(),
  }),
  /**
   * A command the captain (or another agent with majhi tools) wants to run (5.16).
   * `pending` waits for the owner; `applied` ran (with `commit` for undo when it
   * changed config); `rejected`, `failed` and `undone` are final.
   */
  RoomItemBase.extend({
    type: z.literal("approval"),
    agent: IdSchema,
    command: z.string(),
    risk: z.enum(["read", "change", "destructive", "outbound"]),
    /** One line in plain words: "Create org Acme (key ACM)". */
    summary: z.string(),
    /** The command input as JSON, with secrets redacted. */
    input: z.string(),
    /** Why the agent wants it, in its words. */
    reason: z.string().optional(),
    state: z.enum(["pending", "applied", "rejected", "failed", "undone"]),
    /** Set when a saved "always allow" rule ran this without asking: the rule's scope. */
    rule: z.enum(["task", "org"]).optional(),
    /**
     * Set when autonomous mode decided the card (PRV-74): `approved` ran it within its limits,
     * `left` kept it pending for the owner. `why` is one line: the limit that allowed or held it.
     */
    autonomy: z
      .object({
        decision: z.enum(["approved", "left"]),
        why: z.string(),
        /** `captain`: the captain's upkeep decided it (5.18), not autonomous mode. */
        by: z.literal("captain").optional(),
        /** Where the owner fixes what the captain lacked (a sign-in or token). The card links there and the captain retries once it is fixed. */
        fix: ShipFixSchema.optional(),
      })
      .optional(),
    /** Set when it ran with no owner click: the policy or a rule let it. Older cards lack it. */
    alone: z.literal(true).optional(),
    /** Config history commit made by the command, for Undo. */
    commit: z.string().optional(),
    /** Result or error, one line. */
    result: z.string().optional(),
  }),
  /** An agent asks the owner for a secret; the UI renders a secure input, never chat text (5.16). */
  RoomItemBase.extend({
    type: z.literal("secret-request"),
    agent: IdSchema,
    /** The secret's name, like `newrelic-acme`; saved as `secret:<name>`. */
    name: IdSchema,
    /** What to paste, in plain words. */
    label: z.string(),
    /**
     * Set when the value belongs to one secret entry of a connection (an installed MCP server's
     * key): it is stored there, not under `name`.
     */
    bind: z.object({ connection: IdSchema, list: z.enum(["headers", "env"]), field: z.string() }).optional(),
    state: z.enum(["pending", "saved", "cancelled"]),
  }),
  /** An agent asks the owner one or more questions with preset options. */
  RoomItemBase.extend({
    type: z.literal("ask"),
    agent: IdSchema,
    questions: z
      .array(
        z.object({
          id: z.string(),
          question: z.string(),
          options: z.array(z.object({ id: z.string(), label: z.string() })),
          default: z.string().optional(),
          freeText: z.boolean(),
        }),
      )
      .min(1),
    state: z.enum(["pending", "answered", "cancelled"]),
    /** questionId -> the option id chosen, or free text typed. */
    answers: z.record(z.string(), z.string()).optional(),
    /** Set when the captain answered it instead of the owner (5.18). Older items lack it. */
    by: CaptainBySchema.optional(),
  }),
  /**
   * A context budget event (5.13): compaction, handoff to a fresh session, or rotation. `auto` is a
   * compaction the agent's CLI did on its own inside a turn; `native` is one majhi asked for.
   */
  RoomItemBase.extend({
    type: z.literal("context"),
    agent: IdSchema,
    method: z.enum(["native", "auto", "handoff", "rotation", "fresh", "recovery"]),
    /** Tokens before and after, when known. */
    before: z.number().nonnegative().optional(),
    after: z.number().nonnegative().optional(),
    /** Path of the handoff note under the task folder, for `handoff`/`rotation`/`fresh`/`recovery`. */
    note: z.string().optional(),
  }),
  /**
   * A real trade-off for the owner, with the choices spelled out (lead orchestration): "PRV-18
   * overlaps PRV-17 in apps/server/src/runs. Start now and merge later, or wait?" `pending`
   * waits for the owner; the option picked is `chosen`.
   */
  RoomItemBase.extend({
    type: z.literal("choice"),
    agent: IdSchema.optional(),
    question: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() })).min(2),
    state: z.enum(["pending", "answered", "cancelled"]),
    chosen: z.string().optional(),
    /** Set when the captain answered it instead of the owner (5.18). Older items lack it. */
    by: CaptainBySchema.optional(),
  }),
  /**
   * The task waits for the owner's review (majhi posts it when the agents are done). One per task:
   * a new one replaces the pending one before it.
   */
  RoomItemBase.extend({
    type: z.literal("review"),
    /** Whom "Ask for changes" addresses. */
    lead: IdSchema.optional(),
    /** Why the task is back in review when majhi expected to ship it: a ship it could not finish. */
    why: z.string().optional(),
    /** The captain's line when its checks pass and it asks the owner to ship (5.18). */
    ready: z.string().optional(),
    state: CardStateSchema,
    outcome: CardOutcomeSchema.optional(),
  }),
  /** The task paused. Resume, and the fix when majhi knows the cause. One pending per task. */
  RoomItemBase.extend({
    type: z.literal("paused"),
    reason: PausedReasonSchema,
    /** The cause in words, when it is more specific than the reason ("claude-acme is signed out"). */
    why: z.string().optional(),
    /** Set when the captain paused it, itself or through autonomous mode (5.18). Older cards lack it. */
    by: CaptainBySchema.optional(),
    state: CardStateSchema,
    outcome: CardOutcomeSchema.optional(),
  }),
  /**
   * An agent addressed the owner in plain text instead of the ask tool: Reply, and one button per
   * choice read from its message. `replied`: the owner wrote back instead. `moved-on`: the agent
   * kept working without an answer (a later turn, a background run), so nothing waits on the owner.
   */
  RoomItemBase.extend({
    type: z.literal("owner-question"),
    agent: IdSchema,
    /** The question itself, so the card says what is asked wherever it shows. */
    text: z.string().max(600).optional(),
    choices: z.array(z.string()).max(6),
    state: z.enum(["pending", "answered", "replied", "moved-on"]),
    chosen: z.string().optional(),
    /** Set when the captain answered it instead of the owner (5.18). Older items lack it. */
    by: CaptainBySchema.optional(),
  }),
  /** The lead's plan (`record_plan`), shown as one line. Not the ACP to-do list, which is `plan`. */
  RoomItemBase.extend({
    type: z.literal("team-plan"),
    agent: IdSchema,
    version: z.number().int().positive(),
    steps: TeamPlanSchema.shape.steps,
    why: z.string(),
    how: z.array(PlanHowSchema),
  }),
  /** A diagram an agent drew for the owner (`show_diagram`), drawn inline by the diagram canvas. */
  RoomItemBase.extend({
    type: z.literal("diagram"),
    agent: IdSchema,
    spec: DiagramSpecSchema,
  }),
  RoomItemBase.extend({
    type: z.literal("system"),
    level: z.enum(["info", "warn", "error"]),
    text: z.string(),
    agent: IdSchema.optional(),
    /** The decision this line reports, so the owner can say it was wrong (5.12). */
    decision: z.string().max(40).optional(),
  }),
]);
export type RoomItem = z.infer<typeof RoomItemSchema>;

/** Room item types whose text `room.search` looks through: messages, handoffs, system lines and tool output. */
export const SEARCHABLE_ITEM_TYPES = ["owner", "agent", "handoff", "system", "tool"] as const;

/** A piece of a search snippet. `hit` marks the words the query matched. */
export const SearchSnippetPartSchema = z.object({ text: z.string(), hit: z.boolean() });

/** One room item that matches a search, with the task it is in. */
export const RoomSearchHitSchema = z.object({
  task: TaskIdSchema,
  taskTitle: z.string(),
  org: z.string().nullable(),
  /** The room item's id, to scroll to it. */
  item: z.string(),
  type: z.enum(SEARCHABLE_ITEM_TYPES),
  /** The agent that wrote it or ran the tool; absent for the owner and for system lines. */
  agent: IdSchema.optional(),
  at: z.string(),
  snippet: z.array(SearchSnippetPartSchema),
});
export type RoomSearchHit = z.infer<typeof RoomSearchHitSchema>;

export const RoomSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  /** Only tasks of this org. Default: every task. */
  org: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(30),
});

/** Live state of one agent in a task. Not stored as a room item; sent on change. */
export const AgentLiveSchema = z.object({
  agent: IdSchema,
  /**
   * `queued`: waiting for a free slot under the concurrency limits (5.17), see `slot`.
   * `paused`: the task is paused (offline, limit, owner); it resumes from its checkpoint.
   */
  status: z.enum(["idle", "starting", "queued", "working", "waiting", "paused", "stopped", "error"]),
  /** Place in line while `queued`, 1-based. */
  slot: z.number().int().positive().optional(),
  /** Turns in the current session, for `max_turns` rotation. */
  turns: z.number().int().nonnegative().optional(),
  /** One line: what it is doing now. */
  nowDoing: z.string().optional(),
  /** When the agent last sent anything (text, thought, tool call), sent at most every few seconds. */
  activeAt: z.string().optional(),
  /** When the current turn started, while it runs. */
  turnAt: z.string().optional(),
  /** Messages waiting for its next turn. */
  queued: z.number().int().nonnegative(),
  usage: z
    .object({
      used: z.number().nonnegative(),
      /** What `used` is measured against: the context cap, or the model's window when there is no cap. */
      size: z.number().positive(),
      /** The model's window, when the cap makes `size` smaller. */
      window: z.number().positive().optional(),
    })
    .optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Slash commands the agent advertises over ACP. */
  commands: z.array(z.object({ name: z.string(), description: z.string().optional() })),
  /** The last start failed (signed out, at its limit, a missing runner image, a crash). Cleared when it starts. */
  couldNotStart: z.boolean().optional(),
});
export type AgentLive = z.infer<typeof AgentLiveSchema>;

/**
 * `GET /api/tasks/<task-id>/room` (WebSocket). The server sends a snapshot of
 * the last 200 items and every agent's live state, then every upsert. Clients
 * send nothing; actions go through commands. Older items: `room.items`.
 */
export const RoomServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    items: z.array(RoomItemSchema),
    agents: z.array(AgentLiveSchema),
    /** True when older items exist. */
    more: z.boolean(),
    /** The task's background processes (5.15), running and ended. */
    processes: z.array(ProcessInfoSchema).default([]),
  }),
  z.object({ type: z.literal("item"), item: RoomItemSchema }),
  /**
   * More text for a streamed agent message or thought the socket already holds: `append` goes on
   * the end of the item `id`, which must be `offset` characters long now. Anything else is ignored.
   */
  z.object({
    type: z.literal("delta"),
    id: z.string(),
    offset: z.number().int().nonnegative(),
    append: z.string(),
  }),
  z.object({ type: z.literal("agent"), agent: AgentLiveSchema }),
  z.object({ type: z.literal("task"), task: TaskSchema }),
  /** Every process of the task, sent when any changed (output at most every 500 ms). */
  z.object({ type: z.literal("processes"), processes: z.array(ProcessInfoSchema) }),
]);
export type RoomServerMessage = z.infer<typeof RoomServerMessageSchema>;

/**
 * `POST /api/uploads` (multipart, field `file`) stores a file for a task that
 * is being written and answers with an `Attachment` of kind image or file.
 * Its id is passed to `tasks.create` or `room.send`. Max 20 MB. Unused uploads
 * are deleted after a day.
 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** File types that can be attached, by extension (lowercase, no dot), with the mime type each is sent as. */
export const ATTACHMENT_TYPES = {
  images: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" },
  documents: { pdf: "application/pdf" },
  text: {
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    log: "text/plain",
    yaml: "application/yaml",
    yml: "application/yaml",
    xml: "application/xml",
    html: "text/html",
    diff: "text/x-diff",
    patch: "text/x-diff",
  },
  archives: { zip: "application/zip" },
} as const;

const ATTACHMENT_EXTENSIONS: Record<string, string> = Object.assign({}, ...Object.values(ATTACHMENT_TYPES));

/** The allowed types in words, for error messages. */
export const ATTACHMENT_TYPES_TEXT =
  "images (png, jpeg, gif, webp), pdf, text (txt, md, csv, json, log, yaml, xml, html, diff, patch) and zip";

/** For an `<input accept>`: the allowed extensions. */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_EXTENSIONS)
  .map((ext) => `.${ext}`)
  .join(",");

/** The lowercase extension of a file name, without the dot. Empty when there is none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The mime type for an allowed file name, or undefined when its extension is not allowed. */
export function attachmentMime(name: string): string | undefined {
  return ATTACHMENT_EXTENSIONS[extensionOf(name)];
}

/**
 * True when the extension is allowed and the mime type the sender gave fits it. A missing mime
 * type or `application/octet-stream` passes (browsers leave it empty for .md and .log); a
 * mismatch like `text/html` on a .png does not.
 */
export function attachmentAllowed(name: string, mime = ""): boolean {
  const expected = attachmentMime(name);
  if (expected === undefined) return false;
  const given = mime.trim().toLowerCase();
  if (given === "" || given === "application/octet-stream" || given === expected) return true;
  const ext = extensionOf(name);
  if (ext in ATTACHMENT_TYPES.images || ext === "pdf") return false;
  if (ext === "zip") return given === "application/x-zip-compressed" || given === "application/x-zip";
  // Text types: browsers and OSes disagree on the exact mime type of a .yaml or .diff.
  return (
    given.startsWith("text/") ||
    given === "application/json" ||
    given.endsWith("+json") ||
    given.endsWith("xml") ||
    given.endsWith("yaml")
  );
}
