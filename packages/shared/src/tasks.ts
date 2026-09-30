import { z } from "zod";
import { IdSchema, OrgIdSchema } from "./accounts.ts";
import { ProcessInfoSchema } from "./processes.ts";
import { CoordinationModeSchema, HandoffViaSchema, TeamOverrideSchema } from "./rooms.ts";

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

export const ProjectConfigSchema = z.looseObject({
  /** An org id from `orgs`, or `private`. */
  org: OrgIdSchema,
  /** Absolute path, or one starting with `~/`, under a workspace root. */
  path: z.string().trim().min(1),
  /** Words that name this project in the task box: "api", "backend". Lowercase, unique across projects. */
  aliases: z.array(z.string().trim().toLowerCase().min(1)).default([]),
  /** Base branch for tasks. Default: the org's `base`, then the repo's default branch. */
  base: z.string().trim().min(1).optional(),
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

export const PausedReasonSchema = z.enum(["limit", "offline", "error", "owner"]);
export type PausedReason = z.infer<typeof PausedReasonSchema>;

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
  /** Absolute path of the task folder. */
  folder: z.string(),
  repos: z.array(TaskRepoSchema),
  /** Agent ids. The first is the lead: owner messages without a mention go to it. */
  team: z.array(IdSchema),
  /** How the team takes turns (5.3). */
  mode: CoordinationModeSchema,
  /** The owner's model, effort and repo choices per agent for this task. */
  overrides: z.record(IdSchema, TeamOverrideSchema),
  links: z.array(TaskLinkSchema),
  attachments: z.array(AttachmentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

/** One row of the task list. */
export const TaskSummarySchema = TaskSchema.pick({
  id: true,
  title: true,
  kind: true,
  org: true,
  status: true,
  pausedReason: true,
  team: true,
  mode: true,
  updatedAt: true,
}).extend({
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
  /** `from develop`, `base: main`, `off release/2.1`. */
  base: z.string().optional(),
  /** `on feature/x`, `branch fix/y`. Must contain a slash. */
  branch: z.string().optional(),
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

export const RoomItemSchema = z.discriminatedUnion("type", [
  RoomItemBase.extend({
    type: z.literal("owner"),
    text: z.string(),
    attachments: z.array(AttachmentSchema),
    /** Sent while the agent was busy: waits for its next turn. */
    queued: z.boolean(),
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
  }),
  /**
   * A command the boss (or another agent with majhi tools) wants to run (5.16).
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
    state: z.enum(["pending", "saved", "cancelled"]),
  }),
  /** A context budget event (5.13): compaction, handoff to a fresh session, or rotation. */
  RoomItemBase.extend({
    type: z.literal("context"),
    agent: IdSchema,
    method: z.enum(["native", "handoff", "rotation", "fresh", "recovery"]),
    /** Tokens before and after, when known. */
    before: z.number().nonnegative().optional(),
    after: z.number().nonnegative().optional(),
    /** Path of the handoff note under the task folder, for `handoff`/`rotation`/`fresh`/`recovery`. */
    note: z.string().optional(),
  }),
  RoomItemBase.extend({
    type: z.literal("system"),
    level: z.enum(["info", "warn", "error"]),
    text: z.string(),
    agent: IdSchema.optional(),
  }),
]);
export type RoomItem = z.infer<typeof RoomItemSchema>;

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
  /** Messages waiting for its next turn. */
  queued: z.number().int().nonnegative(),
  usage: z.object({ used: z.number().nonnegative(), size: z.number().positive() }).optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  /** Slash commands the agent advertises over ACP. */
  commands: z.array(z.object({ name: z.string(), description: z.string().optional() })),
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
