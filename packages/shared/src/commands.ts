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
  MrHostSchema,
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
import { CleanupPreviewSchema, CleanupReportSchema, CleanupRunInputSchema } from "./cleanup.ts";
import {
  ContainerInfoSchema,
  ContainerNameSchema,
  ImageRefSchema,
  PreviewBuildInputSchema,
  PreviewRunInputSchema,
  ServiceStartInputSchema,
} from "./containers.ts";
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
  EDITOR_PATH_MAX,
  HostResultSchemas,
  HostStatusSchema,
  SSH_PASSPHRASE_MAX,
  SshStatusSchema,
  UpdateStatusSchema,
} from "./host.ts";
import {
  FactHitSchema,
  FactSchema,
  MemoryAddInputSchema,
  MemoryBriefInputSchema,
  MemoryBriefOutputSchema,
  MemoryBulkDecideInputSchema,
  MemoryBulkDecideOutputSchema,
  MemoryDecideInputSchema,
  MemoryEventSchema,
  MemoryEventsInputSchema,
  MemoryExtractInputSchema,
  MemoryExtractOutputSchema,
  MemoryListInputSchema,
  MemoryPinInputSchema,
  MemoryPromoteInputSchema,
  MemoryPromoteOutputSchema,
  MemoryRecordInputSchema,
  MemoryRecordsInputSchema,
  MemoryRestoreBriefInputSchema,
  MemorySearchInputSchema,
  MemoryThreadInputSchema,
  MemoryThreadsInputSchema,
  MemoryUndoInputSchema,
  ProjectBriefSchema,
  TaskRecordHitSchema,
  TaskRecordSchema,
  ThreadSchema,
} from "./memory.ts";
import {
  MarkMergedResultSchema,
  MergeMrsResultSchema,
  MergeOrderSchema,
  OpenMrsResultSchema,
  RefreshMrsResultSchema,
  RepoDiffSchema,
} from "./mrs.ts";
import { ProcessIdSchema, ProcessInfoSchema } from "./processes.ts";
import { CoordinationModeSchema } from "./rooms.ts";
import {
  AllowRuleSchema,
  CleanupPatchSchema,
  ContainersPatchSchema,
  ContextPatchSchema,
  EditorAppSchema,
  EditorPatchSchema,
  LimitsPatchSchema,
  MemoryPatchSchema,
  PolicyPatchSchema,
  ResumePatchSchema,
  RoomPatchSchema,
  SettingsSchema,
} from "./settings.ts";
import {
  CardActionSchema,
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

/** A branch name to merge into, push, or open a merge request against. */
const LocalBranchSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._][A-Za-z0-9._/-]*$/, "Not a branch name")
  .refine((b) => !b.includes(".."), "Not a branch name")
  .max(200);

/** What a local merge or a push did in one repo of a task. */
const MergeResultSchema = z.object({
  project: IdSchema,
  into: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});

/** One action: allowed now, or why not and where to fix it. */
export const ShipOptionSchema = z.object({ ok: z.boolean(), why: z.string().optional() });
export type ShipOption = z.infer<typeof ShipOptionSchema>;

/** `tasks.shipOptions`: what Ship and the review card may do now. */
export const ShipOptionsSchema = z.object({
  /** The first repo's base: the default target. */
  base: z.string().optional(),
  /** The first repo's MR host, so the UI can say PR or MR. */
  host: MrHostSchema.optional(),
  /** Merge into a local branch. Nothing is pushed. */
  merge: ShipOptionSchema,
  /** Merge into a local branch, then push that branch. */
  mergePush: ShipOptionSchema,
  /** Push the task branch. */
  push: ShipOptionSchema,
  /** Push the task branch and open a merge request. */
  mr: ShipOptionSchema,
  /** Mark the task done. */
  done: ShipOptionSchema,
});
export type ShipOptions = z.infer<typeof ShipOptionsSchema>;
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
  "ssh.hosts": {
    risk: "read",
    summary:
      "The Host entries of the owner's ~/.ssh/config (wildcards left out), with their HostName, User and IdentityFile, to pick a project remote's SSH alias",
    input: Empty,
    output: z.array(
      z.object({
        alias: z.string(),
        hostName: z.string().optional(),
        user: z.string().optional(),
        identityFile: z.string().optional(),
      }),
    ),
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
  "editor.open": {
    risk: "change",
    summary:
      "Open a file, a task's worktree or a project folder in the owner's editor (VS Code or Cursor, chosen in settings) through the host helper. The path must be inside a workspace root or the tasks folder",
    input: z.object({
      path: z.string().trim().min(1).max(EDITOR_PATH_MAX),
      /** Jump to this line. Only for a file. */
      line: z.number().int().min(1).optional(),
    }),
    output: z.object({ app: EditorAppSchema, path: z.string() }),
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
      merge: OrgConfigSchema.shape.merge.nullable().optional(),
      mr_tokens: OrgConfigSchema.shape.mr_tokens.nullable().optional(),
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
    input: z.object({ id: IdSchema }).extend(
      ProjectConfigSchema.pick({
        org: true,
        path: true,
        aliases: true,
        base: true,
        remotes: true,
        links: true,
      }).shape,
    ),
    output: ProjectViewSchema,
  },
  "projects.update": {
    risk: "change",
    summary:
      "Change a project's org, aliases or base branch, and (when given) its remotes and links to other projects. null removes remotes or links",
    input: z
      .object({ id: IdSchema })
      .extend(ProjectConfigSchema.pick({ org: true, aliases: true, base: true }).shape)
      .extend({
        remotes: ProjectConfigSchema.shape.remotes.nullable().optional(),
        links: ProjectConfigSchema.shape.links.nullable().optional(),
      }),
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
      /** A short title. Without it, the first line of `text` is the title and the rest the description. */
      title: z.string().trim().min(1).max(120).optional(),
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
  "tasks.terminal.open": {
    risk: "change",
    summary:
      "Open the task's terminal: a shell in the task folder. One per task; opening it again while it runs returns the same terminal",
    input: z.object({ task: TaskIdSchema }),
    output: z.object({ terminalId: z.string() }),
  },
  "tasks.reopen": {
    risk: "change",
    summary: "Open a done task again: back to review when it has a worktree, else the inbox",
    input: z.object({ id: TaskIdSchema }),
    output: TaskSchema,
  },
  "tasks.merge": {
    risk: "outbound",
    summary:
      "Merge the task branch into a local branch in the project's checkout: its base by default, or any other (dev, staging). With push, then push that branch to the project's MR remote, never forced: refused before merging when the remote's copy has commits the local branch lacks. With done, mark the task done after a clean merge (and push)",
    input: z.object({
      id: TaskIdSchema,
      /** The branch to merge into. Default: each repo's base branch. */
      into: LocalBranchSchema.optional(),
      /** Only this repo of the task. Default: every repo. */
      project: IdSchema.optional(),
      done: z.boolean().default(false),
      /** Push the merged branch afterwards. */
      push: z.boolean().default(false),
    }),
    output: z.object({
      results: z.array(MergeResultSchema),
      task: TaskSchema,
    }),
  },
  "tasks.shipOptions": {
    risk: "read",
    summary:
      "What Ship can do with a task now: merge locally, merge and push, push the task branch, open merge requests, mark it done. Each with the reason and where to fix it when it cannot",
    input: z.object({ id: TaskIdSchema }),
    output: ShipOptionsSchema,
  },
  "tasks.branches": {
    risk: "read",
    summary:
      "Local branches of each repo of a task, and the branches its MR remote had at the last fetch, to pick where to merge or open a merge request",
    input: z.object({ id: TaskIdSchema }),
    output: z.array(
      z.object({
        project: IdSchema,
        base: z.string(),
        branches: z.array(z.string()),
        /** The MR remote's branches as this machine last fetched them. */
        remote: z.array(z.string()).default([]),
      }),
    ),
  },
  "tasks.push": {
    risk: "outbound",
    summary:
      "Push the task branch of each repo to its MR remote (through the project's SSH alias), with no merge request. Never forced: a remote branch that moved is refused",
    input: z.object({ id: TaskIdSchema }),
    output: z.object({ results: z.array(MergeResultSchema), task: TaskSchema }),
  },
  // Merge requests (5.5) ------------------------------------------------------
  "tasks.diff": {
    risk: "read",
    summary:
      "Show what each repo of a task changed against its base branch, as git diffs per file, commits and uncommitted work together",
    input: z.object({ id: TaskIdSchema }),
    output: z.array(RepoDiffSchema),
  },
  "tasks.mergeOrder": {
    risk: "read",
    summary:
      "Show the order the task's repos merge in: repos others depend on first, else the task's own order, else the owner's override. Refused when the project links form a loop",
    input: z.object({ id: TaskIdSchema }),
    output: MergeOrderSchema,
  },
  "tasks.setMergeOrder": {
    risk: "change",
    summary:
      "Set the merge order of a task's repos by hand: every project of the task once, first to merge first. null goes back to the order from project links",
    input: z.object({ id: TaskIdSchema, order: z.array(IdSchema).min(1).nullable() }),
    output: TaskSchema,
  },
  "tasks.openMrs": {
    risk: "outbound",
    summary:
      "Push each repo's branch to its MR remote (through the project's SSH alias) and open one merge request per repo, in merge order, then link the sibling MRs in each description. The task moves to mr. Repos with no new commit are skipped",
    input: z.object({
      id: TaskIdSchema,
      /** The branch the merge requests go into. Default: each repo's base branch. */
      into: LocalBranchSchema.optional(),
    }),
    output: OpenMrsResultSchema,
  },
  "tasks.refreshMrs": {
    risk: "change",
    summary:
      "Read each MR's state and CI from its host and store it. When every MR is merged, the task is done, its worktrees are removed and the tasks waiting on it start",
    input: z.object({ id: TaskIdSchema }),
    output: RefreshMrsResultSchema,
  },
  "tasks.mergeMrs": {
    risk: "outbound",
    summary:
      "Merge the task's MRs on their hosts, in merge order, stopping at the first that fails or has failing CI, and say why. Not for the never policy: merge on the host, then use markMerged",
    input: z.object({ id: TaskIdSchema }),
    output: MergeMrsResultSchema,
  },
  "tasks.markMerged": {
    risk: "change",
    summary:
      "The owner merged the MRs on the host (the never policy). Checks each with its host; force records them as merged without that check. When every MR is merged, the task is done",
    input: z.object({
      id: TaskIdSchema,
      /** Only this repo. Default: every repo with an MR. */
      project: IdSchema.optional(),
      force: z.boolean().default(false),
    }),
    output: MarkMergedResultSchema,
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

  // Containers for agents (PRV-53) ----------------------------------------------
  "containers.list": {
    risk: "read",
    summary:
      "Running previews and service containers majhi runs for agents, across tasks or for one task, and whether containers are available",
    input: z.object({ task: TaskIdSchema.optional() }),
    output: z.object({
      available: z.boolean(),
      reason: z.string().optional(),
      containers: z.array(ContainerInfoSchema),
    }),
  },
  "containers.images.allow": {
    risk: "change",
    summary: "Allow an image for service containers that majhi runs for agents",
    input: z.object({ image: ImageRefSchema }),
    output: z.object({ images: z.array(ImageRefSchema) }),
  },
  "containers.images.remove": {
    risk: "change",
    summary: "Stop allowing an image for service containers. Running ones keep running until stopped",
    input: z.object({ image: ImageRefSchema }),
    output: z.object({ images: z.array(ImageRefSchema) }),
  },
  "containers.preview.build": {
    risk: "change",
    summary: "Build the image of a task's repo as its preview, on the task's own builder",
    input: PreviewBuildInputSchema.extend({ task: TaskIdSchema }),
    output: z.object({ process: ProcessInfoSchema }),
  },
  "containers.preview.run": {
    risk: "change",
    summary: "Run the task's preview image on a free port, with a throwaway folder and nothing of the host",
    input: PreviewRunInputSchema.extend({ task: TaskIdSchema }),
    output: z.object({ container: ContainerInfoSchema }),
  },
  "containers.services.start": {
    risk: "change",
    summary: "Start a service container (like postgres) for a task's tests, from an image the owner allowed",
    input: ServiceStartInputSchema.extend({ task: TaskIdSchema }),
    output: z.object({ container: ContainerInfoSchema }),
  },
  "containers.stop": {
    risk: "change",
    summary: "Stop the preview of a task (name preview) or one of its service containers",
    input: z.object({ task: TaskIdSchema, name: ContainerNameSchema }),
    output: z.object({ container: ContainerInfoSchema }),
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
    summary:
      "Approve or reject a command an agent proposed. With always, approving also saves a rule that lets this agent run the same command without asking, for this task or for every task in its org",
    input: z.object({
      task: TaskIdSchema,
      item: z.string(),
      decision: z.enum(["approve", "reject"]),
      always: z.object({ scope: z.enum(["task", "org"]) }).optional(),
    }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.secret": {
    risk: "change",
    summary:
      "Answer an agent's secret request. The value is stored in secrets.age; the agent gets only the reference",
    input: z.object({ task: TaskIdSchema, item: z.string(), value: z.string().min(1).max(8192) }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.cardAction": {
    risk: "outbound",
    summary:
      "Act on a review or paused card in a task room: merge the task into a local branch and mark it done, mark it done, or resume it. Refused when the card was already answered or the task no longer allows it. Never pushes",
    input: z.object({
      task: TaskIdSchema,
      item: z.string(),
      action: CardActionSchema,
      /** For merge: the local branch to merge into. Default: each repo's base branch. */
      into: LocalBranchSchema.optional(),
    }),
    output: z.object({
      item: RoomItemSchema,
      /** For merge: what happened in each repo. */
      results: z.array(MergeResultSchema).optional(),
    }),
  },
  "room.answerQuestion": {
    risk: "change",
    summary:
      'Answer an agent\'s plain-text question to the owner with one of the choices read from it. The agent gets "Owner chose: <choice>"',
    input: z.object({ task: TaskIdSchema, item: z.string(), choice: z.string().min(1).max(200) }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.answerAsk": {
    risk: "change",
    summary: "Answer one or more questions on an ask card and send the answers to the agent",
    input: z.object({
      task: TaskIdSchema,
      item: z.string(),
      /** questionId -> the option id chosen, or free text typed. */
      answers: z.record(z.string(), z.string()),
    }),
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
    summary:
      "Context budget, limits, resume, room, memory and approval policy settings, with defaults applied",
    input: Empty,
    output: SettingsSchema,
  },
  "settings.set": {
    risk: "change",
    summary:
      "Change context budget, limits, resume, room, memory, editor, cleanup or container limit settings (loop guard, review rounds, auto_threshold, review_all, housekeeper, housekeeper_model, editor.app: vscode or cursor, cleanup after_days, container cpus, memory, per_task). Policy changes use policy.set",
    input: z.object({
      context: ContextPatchSchema.optional(),
      limits: LimitsPatchSchema.optional(),
      resume: ResumePatchSchema.optional(),
      rooms: RoomPatchSchema.optional(),
      memory: MemoryPatchSchema.optional(),
      editor: EditorPatchSchema.optional(),
      cleanup: CleanupPatchSchema.optional(),
      containers: ContainersPatchSchema.optional(),
    }),
    output: SettingsSchema,
  },
  "policy.set": {
    risk: "destructive",
    summary: "Change the approval policy for the boss's commands",
    input: PolicyPatchSchema,
    output: SettingsSchema,
  },

  "policy.removeRule": {
    risk: "change",
    summary:
      "Remove one saved always-allow rule, named by its agent, command and scope (task or org). Its commands ask again",
    input: AllowRuleSchema,
    output: SettingsSchema,
  },
  "permissions.list": {
    risk: "read",
    summary:
      "The CLI permission prompts remembered as allow for this task, across tasks, with each task's title",
    input: Empty,
    output: z.array(z.object({ task: TaskIdSchema, title: z.string(), kind: z.string() })),
  },
  "permissions.revoke": {
    risk: "change",
    summary: "Forget one remembered CLI permission choice for a task, so the CLI asks again",
    input: z.object({ task: TaskIdSchema, kind: z.string().min(1) }),
    output: z.array(z.object({ task: TaskIdSchema, title: z.string(), kind: z.string() })),
  },

  // The boss (5.16) ---------------------------------------------------------
  "boss.chat": {
    risk: "change",
    summary: "Open the boss chat, created on first use. With fresh, archive it and start a new conversation",
    input: z.object({ fresh: z.boolean().optional() }),
    output: TaskSchema,
  },

  // Cleanup of done tasks ------------------------------------------------------
  "cleanup.preview": {
    risk: "read",
    summary:
      "List done tasks older than N days (default: the cleanup.after_days setting) with the worktrees, merged task branches and room items a cleanup would remove, and what it would skip and why",
    input: z.object({ days: z.number().int().min(1).max(3650).optional() }),
    output: CleanupPreviewSchema,
  },
  "cleanup.run": {
    risk: "destructive",
    summary:
      "Clean up the listed done tasks: remove clean worktrees, delete merged task branches and delete room items, keeping one note. Checks each task again and never forces. Dirty worktrees and unmerged branches are kept",
    input: CleanupRunInputSchema,
    output: CleanupReportSchema,
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
    summary:
      "Recent decisions, newest first, with the full request, every probability and the outcome. Page with offset",
    input: z.object({
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
    }),
    output: z.array(DecisionRecordSchema),
  },
  "decisions.correct": {
    risk: "change",
    summary:
      "Record the owner's correction of a decision (Wrong pick): the right option, tier or model, and an optional note. Kept for learning; changes nothing else",
    input: z.object({
      id: z.string().min(1).max(40),
      right: z.string().trim().min(1).max(100),
      note: z.string().trim().max(500).optional(),
    }),
    output: DecisionRecordSchema,
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

  // Memory (5.6) --------------------------------------------------------------
  "memory.search": {
    risk: "read",
    summary:
      "Search facts by meaning and keywords, in the scopes you name (default all). Active facts unless a status is given; pinned facts first",
    input: MemorySearchInputSchema,
    output: z.array(FactHitSchema),
  },
  "memory.list": {
    risk: "read",
    summary:
      "List facts, newest first, by scope, status (pending, active, retired, rejected) or the task they were learned in",
    input: MemoryListInputSchema,
    output: z.array(FactSchema),
  },
  "memory.add": {
    risk: "change",
    summary: "Add an active fact in a scope (global, org:<id> or project:<id>), as the owner",
    input: MemoryAddInputSchema,
    output: FactSchema,
  },
  "memory.approve": {
    risk: "change",
    summary: "Make a pending or rejected fact active, so later tasks recall it",
    input: MemoryDecideInputSchema,
    output: FactSchema,
  },
  "memory.reject": {
    risk: "change",
    summary: "Drop a pending fact. It is kept as rejected, so it can be approved later",
    input: MemoryDecideInputSchema,
    output: FactSchema,
  },
  "memory.forget": {
    risk: "destructive",
    summary: "Retire an active fact: it stops being recalled from now on and keeps its history",
    input: MemoryDecideInputSchema,
    output: FactSchema,
  },
  "memory.pin": {
    risk: "change",
    summary: "Pin a fact so it comes first in recall, or unpin it",
    input: MemoryPinInputSchema,
    output: FactSchema,
  },
  "memory.undo": {
    risk: "change",
    summary:
      "Undo one step of the memory log: an automatic keep, drop, retire or merge, or the owner's approve, reject or forget. Refused when the fact changed again since",
    input: MemoryUndoInputSchema,
    output: FactSchema,
  },
  "memory.extract": {
    risk: "change",
    summary:
      "Have the Housekeeper read a task's room and write candidate facts, then curate them: duplicates, keep or drop, contradictions. Spends a small model's tokens",
    input: MemoryExtractInputSchema,
    output: MemoryExtractOutputSchema,
  },
  "memory.promote": {
    risk: "change",
    summary:
      "Add an active project fact to the repo's AGENTS.md: majhi makes a task in that project with the change committed, waiting in review for the owner to merge",
    input: MemoryPromoteInputSchema,
    output: MemoryPromoteOutputSchema,
  },
  "memory.events": {
    risk: "read",
    summary: "The memory log, newest first: proposals, decisions and undo, for one task or fact, or all",
    input: MemoryEventsInputSchema,
    output: z.array(MemoryEventSchema),
  },
  "memory.approveAll": {
    risk: "change",
    summary: "Approve every pending fact (or the ones named). Each step is logged and can be undone",
    input: MemoryBulkDecideInputSchema,
    output: MemoryBulkDecideOutputSchema,
  },
  "memory.rejectAll": {
    risk: "change",
    summary:
      "Reject every pending fact (or the ones named). They are kept as rejected, so each can be undone",
    input: MemoryBulkDecideInputSchema,
    output: MemoryBulkDecideOutputSchema,
  },
  "memory.records": {
    risk: "read",
    summary:
      "Task records: what each finished task was asked, did, decided, where it landed and what it left. Search by meaning and words, or newest first",
    input: MemoryRecordsInputSchema,
    output: z.array(TaskRecordHitSchema),
  },
  "memory.record": {
    risk: "read",
    summary: "The record of one finished task, or null before it is written",
    input: MemoryRecordInputSchema,
    output: TaskRecordSchema.nullable(),
  },
  "memory.brief": {
    risk: "read",
    summary:
      "A project's living brief (what it is, architecture, state, plans, known problems) and every earlier version",
    input: MemoryBriefInputSchema,
    output: MemoryBriefOutputSchema,
  },
  "memory.restoreBrief": {
    risk: "change",
    summary: "Put an earlier version of a project brief back. It becomes the newest version; nothing is lost",
    input: MemoryRestoreBriefInputSchema,
    output: ProjectBriefSchema,
  },
  "memory.buildBrief": {
    risk: "change",
    summary:
      "Have the Housekeeper write a project's brief again from its repo docs and task records. Spends a small model's tokens",
    input: MemoryBriefInputSchema,
    output: ProjectBriefSchema,
  },
  "memory.threads": {
    risk: "read",
    summary: "Open threads: what finished tasks left to do, per project. Open ones unless a status is given",
    input: MemoryThreadsInputSchema,
    output: z.array(ThreadSchema),
  },
  "memory.closeThread": {
    risk: "change",
    summary: "Close an open thread by hand",
    input: MemoryThreadInputSchema,
    output: ThreadSchema,
  },
  "memory.reopenThread": {
    risk: "change",
    summary: "Open a closed thread again",
    input: MemoryThreadInputSchema,
    output: ThreadSchema,
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

/** Verbs after the dot that remove something, whatever the command's risk class says. */
const DESTRUCTIVE_VERB = /^(remove|delete|forget)/i;

/**
 * True for a command that removes or forgets something: its risk is `destructive`, or the word after
 * the last dot starts with remove, delete or forget. That also catches `team.remove`,
 * `tasks.removeAgent` and `projects.remove`, which are `change`. Auto-allow rules skip these unless
 * the owner turned on `allow_destructive_rules`.
 */
export function isDestructiveCommand(name: string): boolean {
  const def = Object.hasOwn(commands, name) ? commands[name as CommandName] : undefined;
  if (def?.risk === "destructive") return true;
  return DESTRUCTIVE_VERB.test(name.slice(name.lastIndexOf(".") + 1));
}
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
