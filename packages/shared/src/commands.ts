import { z } from "zod";
import {
  AccountModelsSchema,
  AccountUsageSchema,
  AccountViewSchema,
  AgentEntrySchema,
  AgentFrontmatterSchema,
  AuthModeSchema,
  HealthCheckSchema,
  IdSchema,
  OrgConfigSchema,
  OrgViewSchema,
  ToolIdSchema,
  ToolInfoSchema,
} from "./accounts.ts";
import {
  ConfigStateSchema,
  RemountSchema,
  ReposResponseSchema,
  WorkspacesUpdateResultSchema,
  WorkspacesUpdateSchema,
} from "./api.ts";
import { DirListingSchema, HostResultSchemas, HostStatusSchema } from "./host.ts";
import {
  ProjectConfigSchema,
  ProjectViewSchema,
  RoomItemSchema,
  TaskIdSchema,
  TaskKindSchema,
  TaskSchema,
  TaskSummarySchema,
} from "./tasks.ts";

/**
 * Every change in majhi is a command (SPEC 5.16). The UI, the palette, the
 * boss agent and tests all call commands through the same endpoint:
 * `POST /api/cmd/<name>` with the input as JSON, answered with the output.
 */
export const RiskClassSchema = z.enum(["read", "change", "destructive", "outbound"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("agent"), id: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;

export interface CommandDef<I extends z.ZodType, O extends z.ZodType> {
  risk: RiskClass;
  summary: string;
  input: I;
  output: O;
}

const Empty = z.object({});
const ById = z.object({ id: IdSchema });

/** Agent fields a caller sets. `id` comes from the command input, never from here. */
const AgentDraftSchema = z.object({
  frontmatter: AgentFrontmatterSchema.omit({ id: true }),
  instructions: z.string().max(64 * 1024),
});

export const commands = {
  "config.get": {
    risk: "read",
    summary: "Show the loaded config, or why it failed to load",
    input: Empty,
    output: ConfigStateSchema,
  },
  "repos.scan": {
    risk: "read",
    summary: "List the git repos found under every workspace root",
    input: z.object({ refresh: z.boolean().optional() }),
    output: ReposResponseSchema,
  },
  "workspaces.set": {
    risk: "change",
    summary: "Set the workspace roots and the tasks folder",
    input: WorkspacesUpdateSchema,
    output: WorkspacesUpdateResultSchema,
  },
  "workspaces.remount": {
    risk: "change",
    summary: "Mount every root in majhi.yaml by restarting majhi through the host helper",
    input: Empty,
    output: z.object({ remount: RemountSchema, unmounted: z.array(z.string()) }),
  },
  "host.status": {
    risk: "read",
    summary: "Show whether the host helper is connected",
    input: Empty,
    output: HostStatusSchema,
  },
  "fs.listDirs": {
    risk: "read",
    summary: "List the subfolders of a folder on the host (default: home)",
    input: z.object({ path: z.string().optional(), showHidden: z.boolean().optional() }),
    output: DirListingSchema,
  },
  "fs.suggestRoots": {
    risk: "read",
    summary: "Suggest workspace roots: folders under home that hold git repos",
    input: Empty,
    output: HostResultSchemas.suggestRoots,
  },

  // Tools and orgs ----------------------------------------------------------
  "tools.list": {
    risk: "read",
    summary: "List the agent CLIs majhi can drive",
    input: Empty,
    output: z.array(ToolInfoSchema),
  },
  "orgs.list": {
    risk: "read",
    summary: "List orgs with their account and agent counts",
    input: Empty,
    output: z.array(OrgViewSchema),
  },
  "orgs.create": {
    risk: "change",
    summary: "Create an org",
    input: z
      .object({ id: IdSchema.refine((id) => id !== "personal" && id !== "root", "This id is reserved") })
      .extend(OrgConfigSchema.pick({ name: true, color: true, base: true, key: true }).shape),
    output: OrgViewSchema,
  },

  // Accounts ----------------------------------------------------------------
  "accounts.list": {
    risk: "read",
    summary: "List accounts with status, usage and agent count",
    input: Empty,
    output: z.array(AccountViewSchema),
  },
  "accounts.suggestId": {
    risk: "read",
    summary: "Suggest a free account id for a tool and org, like claude-acme-2",
    input: z.object({ tool: ToolIdSchema, org: IdSchema }),
    output: z.object({ id: IdSchema }),
  },
  "accounts.create": {
    risk: "change",
    summary: "Add an account. API keys are stored encrypted and never returned",
    input: z
      .object({
        id: IdSchema,
        tool: ToolIdSchema,
        org: IdSchema,
        auth: AuthModeSchema,
        /** Only for `api-key` accounts. Stored in secrets.age; never logged or committed. */
        apiKey: z.string().trim().min(8).max(512).optional(),
      })
      .refine((a) => (a.auth === "api-key") === (a.apiKey !== undefined), {
        message: "Paste an API key for API-key accounts, and none for login accounts",
        path: ["apiKey"],
      }),
    output: AccountViewSchema,
  },
  "accounts.remove": {
    risk: "destructive",
    summary: "Remove an account and its config home. Refused while agents use it",
    input: ById,
    output: z.object({ removed: IdSchema }),
  },
  "accounts.login.start": {
    risk: "change",
    summary: "Start the tool's own login for a login account in a terminal",
    input: ById,
    output: z.object({
      terminalId: z.string(),
      /** The command shown above the terminal, without secrets. */
      command: z.string(),
    }),
  },
  "accounts.health": {
    risk: "read",
    summary: "Check that the account's CLI starts, is signed in and opens an ACP session. Spends no tokens",
    input: ById,
    output: z.object({ account: AccountViewSchema, health: HealthCheckSchema }),
  },
  "accounts.usage": {
    risk: "read",
    summary: "Read the account's 5-hour and weekly usage. Null for API-key accounts. Spends no model tokens",
    input: z.object({ id: IdSchema, refresh: z.boolean().optional() }),
    output: AccountUsageSchema.nullable(),
  },
  "accounts.models": {
    risk: "read",
    summary: "List the models and effort levels the account offers, read over ACP",
    input: z.object({ id: IdSchema, refresh: z.boolean().optional() }),
    output: AccountModelsSchema,
  },

  // Agents ------------------------------------------------------------------
  "agents.list": {
    risk: "read",
    summary: "List agent files, valid or not, with warnings",
    input: Empty,
    output: z.array(AgentEntrySchema),
  },
  "agents.create": {
    risk: "change",
    summary: "Create an agent file",
    input: AgentDraftSchema.extend({ id: IdSchema }),
    output: AgentEntrySchema,
  },
  "agents.update": {
    risk: "change",
    summary: "Replace an agent's settings and instructions",
    input: AgentDraftSchema.extend({ id: IdSchema }),
    output: AgentEntrySchema,
  },
  "agents.duplicate": {
    risk: "change",
    summary: "Copy an agent under a new id",
    input: z.object({ id: IdSchema, newId: IdSchema }),
    output: AgentEntrySchema,
  },
  "agents.remove": {
    risk: "destructive",
    summary: "Delete an agent file. Refused for the boss",
    input: ById,
    output: z.object({ removed: IdSchema }),
  },
  "agents.health": {
    risk: "read",
    summary: "Check the agent's account and that its model and effort are still offered. Spends no tokens",
    input: ById,
    output: HealthCheckSchema,
  },
  "boss.set": {
    risk: "change",
    summary: "Make a root agent the boss",
    input: ById,
    output: z.object({ boss: IdSchema }),
  },

  // Projects ----------------------------------------------------------------
  "projects.list": {
    risk: "read",
    summary: "List registered projects",
    input: Empty,
    output: z.array(ProjectViewSchema),
  },
  "projects.register": {
    risk: "change",
    summary: "Register a repo as a project of an org, with aliases for the task box",
    input: z
      .object({ id: IdSchema })
      .extend(ProjectConfigSchema.pick({ org: true, path: true, aliases: true, base: true }).shape),
    output: ProjectViewSchema,
  },
  "projects.update": {
    risk: "change",
    summary: "Change a project's org, aliases or base branch",
    input: z
      .object({ id: IdSchema })
      .extend(ProjectConfigSchema.pick({ org: true, aliases: true, base: true }).shape),
    output: ProjectViewSchema,
  },
  "projects.remove": {
    risk: "change",
    summary: "Unregister a project. The repo on disk is not touched",
    input: ById,
    output: z.object({ removed: IdSchema }),
  },

  // Tasks -------------------------------------------------------------------
  "tasks.list": {
    risk: "read",
    summary: "List tasks, newest first",
    input: z.object({ includeDone: z.boolean().optional() }),
    output: z.array(TaskSummarySchema),
  },
  "tasks.get": {
    risk: "read",
    summary: "Show one task",
    input: z.object({ id: TaskIdSchema }),
    output: TaskSchema,
  },
  "tasks.create": {
    risk: "change",
    summary: "Create a task from the task box text. With start, create worktrees and start the agent",
    input: z.object({
      text: z.string().trim().min(1).max(20_000),
      /** Overrides what the parser inferred. */
      kind: TaskKindSchema.optional(),
      /** Overrides the default agent. */
      agent: IdSchema.optional(),
      /** Upload ids from POST /api/uploads. */
      attachments: z.array(z.string()).max(20).default([]),
      start: z.boolean(),
    }),
    output: TaskSchema,
  },
  "tasks.start": {
    risk: "change",
    summary: "Create the worktrees if needed and start the task's agent",
    input: z.object({ id: TaskIdSchema }),
    output: TaskSchema,
  },
  "tasks.stop": {
    risk: "change",
    summary: "Stop every agent in the task and pause it with reason owner",
    input: z.object({ id: TaskIdSchema }),
    output: TaskSchema,
  },
  "tasks.close": {
    risk: "change",
    summary: "Mark a task done. Worktrees stay until removed",
    input: z.object({ id: TaskIdSchema }),
    output: TaskSchema,
  },
  "tasks.remove": {
    risk: "destructive",
    summary:
      "Delete a task, its folder and its worktrees. Refused when a worktree has uncommitted changes, unless force",
    input: z.object({ id: TaskIdSchema, force: z.boolean().optional() }),
    output: z.object({ removed: TaskIdSchema }),
  },

  // Room --------------------------------------------------------------------
  "room.send": {
    risk: "change",
    summary: "Send a message to the task's agent. Queued while it works, unless interrupt",
    input: z.object({
      task: TaskIdSchema,
      text: z.string().max(100_000),
      attachments: z.array(z.string()).max(20).default([]),
      /** `interrupt` stops the current turn and sends at once. */
      mode: z.enum(["queue", "interrupt"]).default("queue"),
      /** Default: the agent @mentioned in the text, else the task's first agent. */
      agent: IdSchema.optional(),
    }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.cancel": {
    risk: "change",
    summary: "Stop an agent's current turn (Esc). Queued messages stay queued",
    input: z.object({ task: TaskIdSchema, agent: IdSchema.optional() }),
    output: z.object({ cancelled: z.array(IdSchema) }),
  },
  "room.permission": {
    risk: "change",
    summary: "Answer a permission prompt",
    input: z.object({ task: TaskIdSchema, item: z.string(), option: z.string() }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.items": {
    risk: "read",
    summary: "Older room items, newest first",
    input: z.object({
      task: TaskIdSchema,
      beforeSeq: z.number().int().optional(),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    output: z.object({ items: z.array(RoomItemSchema), more: z.boolean() }),
  },
  "room.files": {
    risk: "read",
    summary: "Files in the task's worktrees matching a query, for @file mentions",
    input: z.object({ task: TaskIdSchema, query: z.string().max(200) }),
    output: z.array(z.object({ path: z.string(), repo: IdSchema })),
  },
} as const satisfies Record<string, CommandDef<z.ZodType, z.ZodType>>;

export type CommandName = keyof typeof commands;
export type CommandInput<N extends CommandName> = z.input<(typeof commands)[N]["input"]>;
export type CommandOutput<N extends CommandName> = z.infer<(typeof commands)[N]["output"]>;

/** Optional metadata sent with a command, recorded in the config history. */
export const CommandMetaSchema = z.object({
  actor: ActorSchema.default({ kind: "owner" }),
  reason: z.string().max(500).optional(),
});
export type CommandMeta = z.infer<typeof CommandMetaSchema>;

/** Header carrying the JSON-encoded CommandMeta on `POST /api/cmd/<name>`. */
export const COMMAND_META_HEADER = "x-majhi-meta";
