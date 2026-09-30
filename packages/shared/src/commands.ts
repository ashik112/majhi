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
  LEGACY_PERSONAL,
  OrgConfigSchema,
  OrgViewSchema,
  PermSchema,
  PRIVATE,
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
import {
  DecideRequestSchema,
  DecisionPatchSchema,
  DecisionRecordSchema,
  DecisionResultSchema,
  DecisionSettingsSchema,
  LayaStatusSchema,
  ProviderIdSchema,
} from "./decisions.ts";
import {
  DirListingSchema,
  HostResultSchemas,
  HostStatusSchema,
  SSH_PASSPHRASE_MAX,
  SshStatusSchema,
  UpdateStatusSchema,
} from "./host.ts";
import { ProcessIdSchema, ProcessInfoSchema } from "./processes.ts";
import { CoordinationModeSchema } from "./rooms.ts";
import {
  ContextPatchSchema,
  LimitsPatchSchema,
  PolicyPatchSchema,
  ResumePatchSchema,
  RoomPatchSchema,
  SettingsSchema,
} from "./settings.ts";
import {
  ProjectConfigSchema,
  ProjectViewSchema,
  RoomItemSchema,
  TaskIdSchema,
  TaskKindSchema,
  TaskSchema,
  TaskSummarySchema,
} from "./tasks.ts";
import {
  DaySchema,
  PriceKeySchema,
  PriceRowSchema,
  PriceSchema,
  TimeZoneSchema,
  TurnRowSchema,
  UsageBreakdownSchema,
  UsageDimensionSchema,
  UsageFiltersSchema,
  UsageRangeSchema,
  UsageSummarySchema,
} from "./usage.ts";

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
  "ssh.reload": {
    risk: "change",
    summary: "Load the Mac's SSH keys into its agent again and report which need a passphrase",
    input: Empty,
    output: SshStatusSchema,
  },
  "ssh.unlock": {
    risk: "change",
    summary: "Unlock an SSH key with its passphrase once; the macOS Keychain keeps it, majhi does not",
    input: z.object({
      /** A path from the last status's `needsPassphrase`. */
      key: z.string().min(1),
      /** Sent to the host helper once. Never logged, stored or returned. */
      passphrase: z
        .string()
        .min(1)
        .max(SSH_PASSPHRASE_MAX)
        .refine((p) => !/[\r\n\0]/.test(p), "A passphrase cannot hold a line break"),
    }),
    output: SshStatusSchema,
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
      .object({
        id: IdSchema.refine(
          (id) => id !== PRIVATE && id !== LEGACY_PERSONAL && id !== "root",
          "This id is reserved",
        ),
      })
      .extend(OrgConfigSchema.pick({ name: true, color: true, base: true, key: true }).shape),
    output: OrgViewSchema,
  },
  "orgs.update": {
    risk: "change",
    summary:
      "Edit an org: name, color, task key, base branch, commit identity, context threshold, automatic resume, loop guard, model and effort tiers or default team. null clears an optional field",
    input: z.object({
      id: IdSchema,
      name: OrgConfigSchema.shape.name.optional(),
      color: OrgConfigSchema.shape.color.optional(),
      base: OrgConfigSchema.shape.base.nullable().optional(),
      key: OrgConfigSchema.shape.key.nullable().optional(),
      identity: OrgConfigSchema.shape.identity.nullable().optional(),
      /** Overrides majhi's `context.compact_at` for this org's agents. */
      context: OrgConfigSchema.shape.context.nullable().optional(),
      /** Overrides majhi's `resume.auto` for this org's runs. */
      resume: OrgConfigSchema.shape.resume.nullable().optional(),
      /** Overrides majhi's `rooms.max_agent_turns` for this org's tasks. */
      rooms: OrgConfigSchema.shape.rooms.nullable().optional(),
      /** Overrides majhi's `decisions.tiers` (model and effort fallback by role) for this org's agents. */
      tiers: OrgConfigSchema.shape.tiers.nullable().optional(),
      /** The default team for new tasks, lead first. null lets the decision provider pick. */
      team: OrgConfigSchema.shape.team.nullable().optional(),
    }),
    output: OrgViewSchema,
  },
  "orgs.rename": {
    risk: "change",
    summary:
      "Change an org's id. Updates its accounts, projects, agents and tasks. Existing task keys stay. The built-in private org cannot be renamed",
    input: z.object({
      id: IdSchema,
      newId: IdSchema.refine(
        (id) => id !== PRIVATE && id !== LEGACY_PERSONAL && id !== "root",
        "This id is reserved",
      ),
    }),
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
  "accounts.hideModel": {
    risk: "change",
    summary:
      "Hide a model of the account from auto picks and fallback tiers, or show it again. An agent that names the model still gets it",
    input: z.object({ id: IdSchema, model: z.string().trim().min(1), hidden: z.boolean() }),
    output: AccountViewSchema,
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
  "agents.edit": {
    risk: "change",
    summary: "Change some of an agent's settings or its instructions, keeping everything else as it is",
    input: z.object({
      id: IdSchema,
      /** Only the fields to change. `null` removes an optional field (model, effort, fallback). */
      set: z
        .object({
          role: AgentFrontmatterSchema.shape.role,
          account: IdSchema,
          model: z.string().trim().min(1).nullable(),
          effort: z.string().trim().min(1).nullable(),
          where: z.array(IdSchema).min(1),
          // Not the frontmatter's own field: that one defaults to [] and would wipe perms in a patch.
          perms: z.array(PermSchema),
          fallback: IdSchema.nullable(),
        })
        .partial()
        .default({}),
      /** Replaces the instructions when given. */
      instructions: z
        .string()
        .max(64 * 1024)
        .optional(),
    }),
    output: AgentEntrySchema,
  },
  "agents.duplicate": {
    risk: "change",
    summary: "Copy an agent under a new id",
    input: z.object({ id: IdSchema, newId: IdSchema }),
    output: AgentEntrySchema,
  },
  "agents.rename": {
    risk: "change",
    summary:
      "Change an agent's id (its @handle). Updates the boss setting, fallbacks, task teams and the decisions agent. Refused while the agent is working. Old room messages keep the old handle",
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
      /** The whole team, lead first. Overrides @mentions and the default team. */
      team: z.array(IdSchema).min(1).max(12).optional(),
      /** How the team takes turns. Default: from the team the decision provider picked, else `lead`. */
      mode: CoordinationModeSchema.optional(),
      /** Upload ids from POST /api/uploads. */
      attachments: z.array(z.string()).max(20).default([]),
      start: z.boolean(),
      /** Makes the new task a child of this one (5.4a). */
      parent: TaskIdSchema.optional(),
      /** The new task waits for these (5.4a); it does not start until they are met. */
      dependsOn: z.array(TaskIdSchema).max(20).default([]),
    }),
    output: TaskSchema,
  },
  "tasks.plan": {
    risk: "read",
    summary:
      "Check which waiting tasks are safe to start now next to the running ones: file overlap, links, and the account's 5-hour and weekly windows. For a parent, its children; for no id, every task waiting to start",
    input: z.object({ id: TaskIdSchema.optional() }),
    output: z.object({
      entries: z.array(
        z.object({
          task: TaskIdSchema,
          title: z.string(),
          action: z.enum(["start", "wait", "switch", "queue", "ask", "blocked"]),
          /** One plain line: why. */
          because: z.string(),
        }),
      ),
    }),
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
  "tasks.update": {
    risk: "change",
    summary:
      "Change a task's title, description (the text after the title line) or its agent. Its key, folder and branch stay. TASK.md is rewritten",
    input: z.object({
      id: TaskIdSchema,
      title: z.string().trim().min(1).max(300).optional(),
      brief: z.string().max(100_000).optional(),
      /** Gives the task to another agent. Refused while an agent of the task is working. */
      agent: IdSchema.optional(),
      /** How the team takes turns (5.3). */
      mode: CoordinationModeSchema.optional(),
    }),
    output: TaskSchema,
  },
  "tasks.split": {
    risk: "change",
    summary:
      "Split a task into child tasks. Each child can wait for earlier children (dependsOn: their positions in the list, from 0). Children start when the owner starts them, or with start",
    input: z.object({
      task: TaskIdSchema,
      children: z
        .array(
          z.object({
            /** Task box text for the child: what to do, which repos. */
            text: z.string().trim().min(1).max(20_000),
            /** Positions of earlier children this one waits for. */
            dependsOn: z.array(z.number().int().min(0).max(19)).max(20).default([]),
            /** When a dependency counts as met. `ready` stacks this child's branch on the dependency's. */
            when: z.enum(["merged", "ready"]).optional(),
            agent: IdSchema.optional(),
          }),
        )
        .min(1)
        .max(20),
      /** Start the children that do not wait, and let the others start when they are free. */
      start: z.boolean().default(false),
    }),
    output: z.object({ children: z.array(TaskSchema) }),
  },

  // Teams (5.3) ---------------------------------------------------------------
  "team.add": {
    risk: "change",
    summary: "Add an agent to a task's team. It must be able to work in the task's org",
    input: z.object({
      task: TaskIdSchema,
      agent: IdSchema,
      /** Make it the lead: first in the team. */
      lead: z.boolean().optional(),
    }),
    output: TaskSchema,
  },
  "team.remove": {
    risk: "change",
    summary: "Remove an agent from a task's team. Its session closes",
    input: z.object({ task: TaskIdSchema, agent: IdSchema }),
    output: TaskSchema,
  },
  "tasks.addAgent": {
    risk: "change",
    summary:
      "Add an agent to a task's team, like team.add. It must be able to work in the task's org. Messages that @mention it go to it",
    input: z.object({
      id: TaskIdSchema,
      agent: IdSchema,
      /** Make it the lead: first in the team, and the agent unmentioned messages go to. */
      lead: z.boolean().optional(),
    }),
    output: TaskSchema,
  },
  "tasks.removeAgent": {
    risk: "change",
    summary:
      "Remove an agent from a task's team, like team.remove. Refused while it works and for the last agent. Its session closes",
    input: z.object({ id: TaskIdSchema, agent: IdSchema }),
    output: TaskSchema,
  },
  "team.swap": {
    risk: "change",
    summary: "Replace an agent in a task's team with another, in the same place. The old session closes",
    input: z.object({ task: TaskIdSchema, agent: IdSchema, with: IdSchema }),
    output: TaskSchema,
  },
  "team.set": {
    risk: "change",
    summary:
      "Set an agent's model, effort or repos for this task only. null clears a value. A change applies from its next session",
    input: z.object({
      task: TaskIdSchema,
      agent: IdSchema,
      model: z.string().trim().min(1).nullable().optional(),
      effort: z.string().trim().min(1).nullable().optional(),
      /** Projects the agent edits in this task; null: every repo. */
      repos: z.array(IdSchema).nullable().optional(),
    }),
    output: TaskSchema,
  },
  "tasks.close": {
    risk: "change",
    summary: "Mark a task done. Worktrees stay until removed",
    input: z.object({ id: TaskIdSchema }),
    output: TaskSchema,
  },
  "tasks.merge": {
    risk: "outbound",
    summary:
      "Merge the task branch into a local branch in the project's checkout: its base by default, or any other (dev, staging). Never pushes. With done, mark the task done after a clean merge",
    input: z.object({
      id: TaskIdSchema,
      /** The branch to merge into. Default: each repo's base branch. */
      into: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, "Not a branch name")
        .max(200)
        .optional(),
      /** Only this repo of the task. Default: every repo. */
      project: IdSchema.optional(),
      done: z.boolean().default(false),
    }),
    output: z.object({
      results: z.array(
        z.object({ project: IdSchema, into: z.string(), ok: z.boolean(), detail: z.string() }),
      ),
      task: TaskSchema,
    }),
  },
  "tasks.branches": {
    risk: "read",
    summary: "Local branches of each repo of a task, to pick where to merge",
    input: z.object({ id: TaskIdSchema }),
    output: z.array(z.object({ project: IdSchema, base: z.string(), branches: z.array(z.string()) })),
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
  "room.choose": {
    risk: "change",
    summary: "Answer a choice card in the room",
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
  "processes.stop": {
    risk: "change",
    summary: "Stop a background process of a task (the Stop button in the Processes card)",
    input: z.object({ task: TaskIdSchema, id: ProcessIdSchema }),
    output: z.object({ process: ProcessInfoSchema }),
  },

  // Task links (5.4a) ---------------------------------------------------------
  "tasks.link": {
    risk: "change",
    summary: "Link a task to another: make it a child, or make it wait for another task",
    input: z.object({
      task: TaskIdSchema,
      type: z.enum(["parent", "depends-on"]),
      /** The other task. For `parent`, the parent. */
      target: TaskIdSchema,
      /** For `depends-on`: met when merged (default) or when ready for review. */
      when: z.enum(["merged", "ready"]).optional(),
    }),
    output: TaskSchema,
  },
  "tasks.unlink": {
    risk: "change",
    summary: "Remove a link between two tasks",
    input: z.object({
      task: TaskIdSchema,
      type: z.enum(["parent", "depends-on", "follow-up"]),
      target: TaskIdSchema,
    }),
    output: TaskSchema,
  },

  // Room control (5.13, 5.16) ------------------------------------------------
  "room.fresh": {
    risk: "change",
    summary: "Replace an agent's session with a fresh one, carrying a handoff note",
    input: z.object({ task: TaskIdSchema, agent: IdSchema.optional() }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.approve": {
    risk: "change",
    summary: "Approve or reject a command an agent proposed",
    input: z.object({ task: TaskIdSchema, item: z.string(), decision: z.enum(["approve", "reject"]) }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.secret": {
    risk: "change",
    summary:
      "Answer an agent's secret request. The value is stored in secrets.age; the agent gets only the reference",
    input: z.object({ task: TaskIdSchema, item: z.string(), value: z.string().min(1).max(8192) }),
    output: z.object({ item: RoomItemSchema }),
  },

  // Secrets (5.16) ------------------------------------------------------------
  "secrets.list": {
    risk: "read",
    summary: "List secret names. Values are never returned",
    input: Empty,
    output: z.array(z.object({ name: IdSchema, ref: z.string() })),
  },
  "secrets.save": {
    risk: "change",
    summary: "Save a secret in secrets.age and return its reference",
    input: z.object({
      /** Default: derived from the label or the kind of secret. */
      name: IdSchema.optional(),
      value: z.string().min(1).max(8192),
      label: z.string().max(200).optional(),
    }),
    output: z.object({ name: IdSchema, ref: z.string() }),
  },
  "secrets.remove": {
    risk: "destructive",
    summary: "Delete a secret. Refused while config refers to it",
    input: z.object({ name: IdSchema }),
    output: z.object({ removed: IdSchema }),
  },

  // Config history and undo (5.16) --------------------------------------------
  "history.list": {
    risk: "read",
    summary: "Config changes, newest first",
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    output: z.array(
      z.object({
        commit: z.string(),
        at: z.string(),
        /** `owner`, `manual` (hand edit) or an agent id. */
        actor: z.string(),
        command: z.string().optional(),
        summary: z.string(),
        reason: z.string().optional(),
        /** True when an Undo commit already reverted it. */
        undone: z.boolean(),
      }),
    ),
  },
  "history.undo": {
    risk: "change",
    summary: "Undo one config change by reverting its commit",
    input: z.object({ commit: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    output: z.object({ commit: z.string(), summary: z.string() }),
  },

  // Settings (5.7, 5.13, 5.16, 5.17) ------------------------------------------
  "settings.get": {
    risk: "read",
    summary: "Context budget, limits, resume, room and approval policy settings, with defaults applied",
    input: Empty,
    output: SettingsSchema,
  },
  "settings.set": {
    risk: "change",
    summary:
      "Change context budget, limits, resume or room settings (loop guard, review rounds). Policy changes use policy.set",
    input: z.object({
      context: ContextPatchSchema.optional(),
      limits: LimitsPatchSchema.optional(),
      resume: ResumePatchSchema.optional(),
      rooms: RoomPatchSchema.optional(),
    }),
    output: SettingsSchema,
  },
  "policy.set": {
    risk: "destructive",
    summary: "Change the approval policy for the boss's commands",
    input: PolicyPatchSchema,
    output: SettingsSchema,
  },

  // The boss (5.16) ---------------------------------------------------------
  "boss.chat": {
    risk: "change",
    summary: "Open the boss chat, created on first use. With fresh, archive it and start a new conversation",
    input: z.object({ fresh: z.boolean().optional() }),
    output: TaskSchema,
  },

  // Health and updates (no manual work outside majhi) ------------------------
  "health.run": {
    risk: "read",
    summary: "Run every doctor check: config, mounts, SSH, CLIs, accounts, disk, host helper",
    input: Empty,
    output: z.object({
      checkedAt: z.string(),
      checks: z.array(
        z.object({
          id: z.string(),
          group: z.enum(["majhi", "host", "ssh", "accounts", "disk"]),
          label: z.string(),
          /** False only for a failure. A warning is ok, with `level` "warn". */
          ok: z.boolean(),
          level: z.enum(["pass", "warn", "fail"]).optional(),
          detail: z.string(),
          /** A fix majhi can do itself, run with health.fix. */
          fix: z.object({ label: z.string() }).optional(),
        }),
      ),
    }),
  },
  "health.fix": {
    risk: "change",
    summary: "Run the fix majhi offers for a failed check",
    input: z.object({ id: z.string() }),
    output: z.object({
      ok: z.boolean(),
      detail: z.string(),
      /** Something the UI does next, like opening the sign-in terminal, which only the browser can show. */
      open: z.object({ kind: z.literal("sign-in"), account: z.string() }).optional(),
    }),
  },
  "system.version": {
    risk: "read",
    summary: "The running version and whether newer code is on disk",
    input: Empty,
    output: z.object({
      /** Git commit the running image was built from. */
      running: z.string(),
      /** Git commit of the checkout on disk, from the host helper. Absent without a helper. */
      onDisk: z.string().optional(),
      updateReady: z.boolean(),
      /** Commit subjects between running and onDisk, newest first, at most 20. */
      changes: z.array(z.string()),
      /** True when the checkout has uncommitted changes. The update builds them too. */
      dirty: z.boolean().optional(),
      /** True when a host helper is connected, so the update can run from the UI. */
      canUpdate: z.boolean().optional(),
      /** The last update the helper ran, while it runs and after. */
      update: UpdateStatusSchema.optional(),
      /** Agents in the middle of a turn. An update cuts their turns; they resume after the restart. */
      working: z.number().int().nonnegative().optional(),
      /** True while an update waits for the working agents to finish ("Update when they finish"). */
      waiting: z.boolean().optional(),
    }),
  },
  "system.update": {
    risk: "change",
    summary:
      "Rebuild majhi from the code on disk and restart it, through the host helper. With when idle, wait until no agent is working",
    input: z.object({ when: z.enum(["now", "idle"]).default("now") }),
    output: z.object({
      /** `waiting`: the update starts by itself once no agent is working. */
      state: z.enum(["restarting", "manual", "waiting"]),
      /** Why the owner has to run `make up` when the state is manual. */
      reason: z.string().optional(),
    }),
  },

  // Decisions (5.12) ----------------------------------------------------------
  "decisions.ask": {
    risk: "read",
    summary: "Ask the decision model typed questions about some text. Jev is used only when enabled",
    input: DecideRequestSchema,
    output: DecisionResultSchema,
  },
  "decisions.recent": {
    risk: "read",
    summary: "Recent decisions, newest first",
    input: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    output: z.array(DecisionRecordSchema),
  },
  "decisions.status": {
    risk: "read",
    summary: "The provider order and whether each provider can answer now, with Laya's install state",
    input: Empty,
    output: z.object({
      settings: DecisionSettingsSchema,
      laya: LayaStatusSchema,
      providers: z.array(z.object({ id: ProviderIdSchema, available: z.boolean(), detail: z.string() })),
    }),
  },
  "decisions.set": {
    risk: "change",
    summary:
      "Change the provider order, the stand-in agent, Jev's key, when an answer counts (min_lift, min_margin), the role tiers or the per-run limit",
    input: DecisionPatchSchema,
    output: DecisionSettingsSchema,
  },
  "decisions.install": {
    risk: "change",
    summary: "Install Laya on this Mac through the host helper and download its model (about 850 MB, once)",
    input: Empty,
    output: LayaStatusSchema,
  },

  // Tokens and cost (5.8, Phase 2c) -------------------------------------------
  "usage.summary": {
    risk: "read",
    summary:
      "Tokens and cost for today, this week (from Monday), this month and all time, the last 30 days and this month's top tasks. Filter by org, project, agent, account, model or task",
    input: z.object({
      filters: UsageFiltersSchema.default({}),
      /** Days follow this time zone. Default: majhi's own. */
      tz: TimeZoneSchema.optional(),
    }),
    output: UsageSummarySchema,
  },
  "usage.breakdown": {
    risk: "read",
    summary:
      "Tokens and cost grouped by org, project, agent, account, model, task or day, for a range or the days from and to (inclusive), with filters",
    input: z.object({
      by: UsageDimensionSchema,
      range: UsageRangeSchema.default("month"),
      /** First local day, with `to`. Replaces `range`. */
      from: DaySchema.optional(),
      to: DaySchema.optional(),
      filters: UsageFiltersSchema.default({}),
      tz: TimeZoneSchema.optional(),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    output: UsageBreakdownSchema,
  },
  "usage.turns": {
    risk: "read",
    summary: "The recorded turns behind the totals, newest first, with filters",
    input: z.object({
      filters: UsageFiltersSchema.default({}),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    output: z.array(TurnRowSchema),
  },
  "usage.prices": {
    risk: "read",
    summary: "The price table in dollars per million tokens: majhi's defaults and the owner's rows",
    input: Empty,
    output: z.object({ checked: z.string(), rows: z.array(PriceRowSchema) }),
  },
  "usage.setPrice": {
    risk: "change",
    summary:
      "Set the price of a model (dollars per million tokens), or remove the owner's row with price null. New turns use it; recorded turns keep their cost",
    input: z.object({ model: PriceKeySchema, price: PriceSchema.nullable() }),
    output: z.object({ checked: z.string(), rows: z.array(PriceRowSchema) }),
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
