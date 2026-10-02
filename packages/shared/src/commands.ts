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
import { AgentToolRefSchema, AttachedToolsSchema } from "./agent-tools.ts";
import {
  ConfigStateSchema,
  RemountSchema,
  ReposResponseSchema,
  WorkspacesUpdateResultSchema,
  WorkspacesUpdateSchema,
} from "./api.ts";
import { ApprovalStatsSchema } from "./approval-stats.ts";
import { AuditListInputSchema, AuditListSchema } from "./audit.ts";
import {
  AutomationRunSchema,
  ScheduleCreateInputSchema,
  ScheduleIdSchema,
  ScheduleUpdateInputSchema,
  ScheduleViewSchema,
} from "./automation.ts";
import {
  AutonomyAnswerInputSchema,
  AutonomyAnswerResultSchema,
  AutonomyEventSchema,
  AutonomyEventsInputSchema,
  AutonomyGuideInputSchema,
  AutonomyGuideResultSchema,
  AutonomyNoteInputSchema,
  AutonomyPlanInputSchema,
  AutonomyStatusSchema,
  AutonomyStopInputSchema,
} from "./autonomy.ts";
import { BudgetStatusSchema } from "./budgets.ts";
import { CleanupPreviewSchema, CleanupReportSchema, CleanupRunInputSchema } from "./cleanup.ts";
import {
  ConnectionCreateInputSchema,
  ConnectionSetFileInputSchema,
  ConnectionSetSecretInputSchema,
  ConnectionTestResultSchema,
  ConnectionTypeDefSchema,
  ConnectionUpdateInputSchema,
  ConnectionViewSchema,
} from "./connections.ts";
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
import { GitStatusSchema } from "./git-accounts.ts";
import {
  DirListingSchema,
  EDITOR_PATH_MAX,
  GitLoginsResultSchema,
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
  MemoryEditInputSchema,
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
  AutonomyPatchSchema,
  BudgetsPatchSchema,
  CleanupPatchSchema,
  CommitsPatchSchema,
  ContainersPatchSchema,
  ContextPatchSchema,
  EditorAppSchema,
  EditorPatchSchema,
  LimitsPatchSchema,
  MemoryPatchSchema,
  NotificationsPatchSchema,
  PolicyPatchSchema,
  ResumePatchSchema,
  RoomPatchSchema,
  SettingsSchema,
} from "./settings.ts";
import {
  AttachmentSchema,
  CardActionSchema,
  ChangeBranchInputSchema,
  ChangeBranchResultSchema,
  MergeMethodSchema,
  ProjectConfigSchema,
  ProjectViewSchema,
  RoomItemSchema,
  RoomSearchHitSchema,
  RoomSearchInputSchema,
  TaskIdSchema,
  TaskKindSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskSummarySchema,
} from "./tasks.ts";
import {
  TriggerCreateInputSchema,
  TriggerIdSchema,
  TriggerUpdateInputSchema,
  TriggerViewSchema,
} from "./triggers.ts";
import {
  AgentReceiptSchema,
  DaySchema,
  PriceKeySchema,
  PriceRowSchema,
  PriceSchema,
  TaskReceiptSchema,
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

/**
 * The branch each repo ships into, by project. Repos not named here ship into `into` when given and
 * the repos share one base (or their base is `into`), else into their own base.
 */
const ShipTargetsSchema = z.record(IdSchema, LocalBranchSchema);

/**
 * The repos a new task changes, picked on purpose: each gets a branch and a worktree. Project
 * names in the task text attach nothing; agents can read every registered project without it.
 */
const TaskReposSchema = z
  .array(
    z.object({
      project: IdSchema,
      /** The branch it starts from. Default: the project's base. */
      base: LocalBranchSchema.optional(),
      /** Owner only, for a protected project: let agents write in it for this task. */
      writes: z.boolean().optional(),
    }),
  )
  .max(20)
  .describe(
    "The projects this task will change, each with an optional base branch. Only these get a branch and a worktree. Naming a project in the text attaches nothing, and every registered project is readable without being listed here: list only the repos the task must change",
  );

/** What a local merge or a push did in one repo of a task. */
const MergeResultSchema = z.object({
  project: IdSchema,
  into: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  /** The files that conflicted, when a merge stopped on conflicts. Nothing was merged. */
  conflicts: z.array(z.string()).optional(),
  /** The repo has no change since the task started, so nothing was done in it. */
  skipped: z.boolean().optional(),
  /** Merged into the local target, but the push failed: Push again sends it. */
  notPushed: z.boolean().optional(),
});

/** Where the owner fixes what blocks a Ship action: a project's remotes, or an org's settings. */
export const ShipFixSchema = z.discriminatedUnion("page", [
  z.object({ page: z.literal("projects"), project: IdSchema }),
  z.object({ page: z.literal("orgs"), org: IdSchema }),
]);
export type ShipFix = z.infer<typeof ShipFixSchema>;

/** One action: allowed now, or why not and where to fix it. */
export const ShipOptionSchema = z.object({
  ok: z.boolean(),
  why: z.string().optional(),
  fix: ShipFixSchema.optional(),
});
export type ShipOption = z.infer<typeof ShipOptionSchema>;

/** One repo of a task whose branch has commits that are not merged, pushed or in a pull request. */
export const UnshippedRepoSchema = z.object({
  project: IdSchema,
  branch: z.string(),
  /** Commits on the branch that are nowhere else. */
  commits: z.number().int().nonnegative(),
  /** Set when git could not say: the branch counts as not shipped. */
  problem: z.string().optional(),
});
export type UnshippedRepo = z.infer<typeof UnshippedRepoSchema>;

/** Closing a task that has work not shipped: the owner confirms it with `keep`. */
export const UnshippedChoiceSchema = z.literal("keep");

/** `tasks.shipOptions`: what Ship and the review card may do now. */
export const ShipOptionsSchema = z.object({
  /** The first changed repo's base: the default target. */
  base: z.string().optional(),
  /** The repos with changes since the task started, each with its base: the ones Ship sends. */
  changed: z.array(z.object({ project: IdSchema, base: z.string(), branch: z.string() })).optional(),
  /** The repos with no change since the task started: every Ship action skips them. */
  unchanged: z.array(IdSchema).optional(),
  /** Changed repos of protected projects: never in a ship with others, each ships alone when the owner types its name. */
  protected: z.array(z.object({ project: IdSchema, base: z.string(), branch: z.string() })).optional(),
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
  /** Mark the task done. `unshipped` lists the repos whose commits would stay behind on their branch. */
  done: ShipOptionSchema.extend({ unshipped: z.array(UnshippedRepoSchema).optional() }),
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
  "git.logins": {
    risk: "read",
    summary:
      "The accounts this Mac is logged in as on git hosts: gh and glab logins, and SSH keys per host or alias. Never returns a token",
    input: z.object({ refresh: z.boolean().optional() }),
    output: GitLoginsResultSchema,
  },
  "orgs.useGitLogin": {
    risk: "change",
    summary:
      "Use this Mac's gh or glab login as the org's token for a git host: the helper reads the token once and it is saved in secrets.age as that org's mr_tokens entry. Never returns the token",
    input: z.object({
      id: IdSchema,
      via: z.enum(["gh", "glab"]),
      /** The git host name the login was found for, like `github.com`. */
      host: z.string().min(1).max(255),
    }),
    output: z.object({ id: IdSchema, host: MrHostSchema, ref: z.string() }),
  },
  "orgs.useSavedLogin": {
    risk: "change",
    summary:
      "Use the login this Mac saved for an org's git account (Keychain or gh) as that account's token: the helper reads it once, the host's API must accept it, then it is saved in secrets.age for this org only. When it is not a token, nothing is saved and the reason says so. Never returns the secret",
    input: z.object({
      id: IdSchema,
      host: z.string().trim().min(1).max(255),
      account: z.string().trim().min(1).max(255),
    }),
    output: z.object({ saved: z.boolean(), reason: z.string().optional() }),
  },
  "orgs.setGitAccount": {
    risk: "change",
    summary:
      "Bind a git account to an org on one host, like acme-dev on gitlab.com. Projects of this org then push with that account's SSH route. Adopts the Mac's gh or glab login token for it when one exists, or saves a pasted token. Fills the org's commit identity only when it has none. Never returns a token",
    input: z.object({
      id: IdSchema,
      host: z.string().trim().min(1).max(255),
      account: z.string().trim().min(1).max(255),
      /** A `Host` alias from the detected SSH logins. Absent: the host's default key. */
      ssh: z.string().trim().min(1).max(255).optional(),
      /** A pasted token (GitLab personal access token, Bitbucket `email:api-token`), saved in secrets. */
      token: z.string().min(1).max(4096).optional(),
    }),
    output: OrgViewSchema,
  },
  "orgs.gitStatus": {
    risk: "read",
    summary:
      "An org's git accounts per host: how each pushes (SSH key or this Mac's saved login), whether its merge request token works and as whom (one call to the host's API), and the hosts its projects use that have no account yet, with the logins found on this Mac. Never returns a token",
    input: z.object({
      id: IdSchema,
      /** Detect this Mac's logins again and recheck tokens, skipping the cache. */
      refresh: z.boolean().optional(),
    }),
    output: GitStatusSchema,
  },
  "orgs.dismissGitLogin": {
    risk: "change",
    summary: "Stop offering a login found on this Mac as an org's account on a host. Only that org changes",
    input: z.object({
      id: IdSchema,
      host: z.string().trim().min(1).max(255),
      account: z.string().trim().min(1).max(255),
    }),
    output: OrgViewSchema,
  },
  "orgs.removeGitAccount": {
    risk: "change",
    summary: "Remove an org's git account for a host. Its token secret is left in secrets",
    input: z.object({
      id: IdSchema,
      host: z.string().trim().min(1).max(255),
      account: z.string().trim().min(1),
    }),
    output: OrgViewSchema,
  },
  "projects.pushRoute": {
    risk: "read",
    summary: "How a project pushes its MR remote over SSH, and the keys that could do it",
    input: z.object({ id: IdSchema }),
    output: z.object({
      host: z.string().optional(),
      state: z.enum(["picked", "auto", "ambiguous", "none", "ssh", "https"]),
      /** A plain sentence like "Pushes as acme-dev via github.com key". */
      label: z.string().optional(),
      choices: z.array(z.object({ alias: z.string().optional(), account: z.string(), label: z.string() })),
    }),
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
  "notify.test": {
    risk: "change",
    summary:
      "Send a test notification to the Mac and to open browser tabs, as the notification settings allow, so the owner can see they work",
    input: z.object({}),
    output: z.object({
      /** `off`: turned off in settings. `no-helper`: the host helper is not connected. */
      mac: z.enum(["sent", "off", "no-helper", "failed"]),
      /** Why the Mac notification failed, in plain words. */
      error: z.string().optional(),
      /** Whether open tabs were told to show one. */
      browser: z.boolean(),
    }),
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
      "Edit an org: name, color, task key, base branch, commit identity, agent attribution in commits, context threshold and cap, automatic resume, loop guard, model and effort tiers, default team or which tasks leads may start. null clears an optional field",
    input: z.object({
      id: IdSchema,
      name: OrgConfigSchema.shape.name.optional(),
      color: OrgConfigSchema.shape.color.optional(),
      base: OrgConfigSchema.shape.base.nullable().optional(),
      key: OrgConfigSchema.shape.key.nullable().optional(),
      identity: OrgConfigSchema.shape.identity.nullable().optional(),
      /** Overrides majhi's `context.compact_at` and `context.cap` for this org's agents. */
      context: OrgConfigSchema.shape.context.nullable().optional(),
      /** Overrides majhi's `resume.auto` for this org's runs. */
      resume: OrgConfigSchema.shape.resume.nullable().optional(),
      /** Overrides majhi's `commits.attribution` for this org's commits. */
      commits: OrgConfigSchema.shape.commits.nullable().optional(),
      /** Overrides majhi's `rooms.max_agent_turns` for this org's tasks. */
      rooms: OrgConfigSchema.shape.rooms.nullable().optional(),
      /** Overrides majhi's `decisions.tiers` (model and effort fallback by role) for this org's agents. */
      tiers: OrgConfigSchema.shape.tiers.nullable().optional(),
      /** The default team for new tasks, lead first. null lets the decision provider pick. */
      team: OrgConfigSchema.shape.team.nullable().optional(),
      merge: OrgConfigSchema.shape.merge.nullable().optional(),
      /** Which tasks a lead may start without asking. null goes back to `children`. */
      lead_start: OrgConfigSchema.shape.lead_start.nullable().optional(),
      mr_tokens: OrgConfigSchema.shape.mr_tokens.nullable().optional(),
      git_accounts: OrgConfigSchema.shape.git_accounts.nullable().optional(),
      dismissed_logins: OrgConfigSchema.shape.dismissed_logins.nullable().optional(),
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
          // Names to add, and `-name` to turn a default off. See TOOL_CATALOG.
          tools: z.array(AgentToolRefSchema),
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
  "agents.attached": {
    risk: "read",
    summary:
      "The MCP servers the agent's latest run attached, with the task and time. Null when it has not run since majhi started recording them",
    input: z.object({ id: IdSchema }),
    output: AttachedToolsSchema.nullable(),
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
      "Change a project's org, aliases or base branch, and (when given) its remotes, links to other projects, agent attribution in commits and whether it is protected (only the owner turns protection off). null removes remotes, links or the attribution override",
    input: z
      .object({ id: IdSchema })
      .extend(ProjectConfigSchema.pick({ org: true, aliases: true, base: true, protected: true }).shape)
      .extend({
        remotes: ProjectConfigSchema.shape.remotes.nullable().optional(),
        links: ProjectConfigSchema.shape.links.nullable().optional(),
        /** Overrides the org's `commits.attribution` for this project. null clears it. */
        commits: ProjectConfigSchema.shape.commits.nullable().optional(),
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
    summary:
      "Create a task. repos lists the projects it changes: only those get a branch and a worktree; project names in the text attach nothing. With start, create worktrees and start the agent",
    input: z.object({
      text: z.string().trim().min(1).max(20_000),
      /** The repos the task changes. Default: none, a chat task. */
      repos: TaskReposSchema.optional(),
      /** A short title. Without it, the first line of `text` is the title and the rest the description. */
      title: z.string().trim().min(1).max(120).optional(),
      /** Overrides what the parser inferred. */
      kind: TaskKindSchema.optional(),
      /**
       * An investigation: the repos listed in repos are mounted read-only. No branch, no worktree, no
       * Changes and no Ship. `kind: "ops"` does the same.
       */
      readOnly: z.boolean().optional(),
      /** Overrides the default agent. */
      agent: IdSchema.optional(),
      /** The whole team, lead first. Overrides @mentions and the default team. */
      team: z.array(IdSchema).min(1).max(12).optional(),
      /** How the team takes turns. Default: from the team the decision provider picked, else `lead`. */
      mode: CoordinationModeSchema.optional(),
      /**
       * Upload ids (from POST /api/uploads or uploads.create), or paths of files in your own task
       * folder, like attachments/image.png. A path is copied; the original stays.
       */
      attachments: z
        .array(z.string())
        .max(20)
        .default([])
        .describe(
          "Files to attach: an upload id, or the path of a file in your own task folder like attachments/image.png (copied, the original stays)",
        ),
      start: z.boolean(),
      /** Makes the new task a child of this one (5.4a). */
      parent: TaskIdSchema.optional(),
      /** The new task waits for these (5.4a); it does not start until they are met. */
      dependsOn: z.array(TaskIdSchema).max(20).default([]),
      /**
       * Makes the new task a fix task of this one: it gets a `follow-up` link to it (5.15). A fix
       * task starts only when the owner approves, whatever the org's `lead_start` says.
       */
      followUpOf: TaskIdSchema.optional(),
      /**
       * Connection ids its root agents get beyond the task's org's (5.14), like a cluster of another org
       * for a task without one. An org agent can only name its own org's.
       */
      connections: z.array(IdSchema).max(50).optional(),
    }),
    output: TaskSchema,
  },
  "tasks.report": {
    risk: "read",
    summary:
      "Read REPORT.md from the task folder (an ops task's write-up: summary, timeline, evidence, cause, what was changed, follow-ups), with the time it was last changed. Null until the file exists",
    input: z.object({ id: TaskIdSchema }),
    output: z.object({ content: z.string(), modifiedAt: z.string() }).nullable(),
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
      "Change a task's title, description (the text after the title line), its agent, or the owner's priority (high, normal, low) and deadline (due, YYYY-MM-DD). Its key, folder and branch stay. TASK.md is rewritten",
    input: z.object({
      id: TaskIdSchema,
      title: z.string().trim().min(1).max(300).optional(),
      brief: z.string().max(100_000).optional(),
      /** Gives the task to another agent. Refused while an agent of the task is working. */
      agent: IdSchema.optional(),
      /** How the team takes turns (5.3). */
      mode: CoordinationModeSchema.optional(),
      /** The owner's priority; null clears it (normal). */
      priority: TaskPrioritySchema.nullable().optional(),
      /** The deadline, `YYYY-MM-DD`; null clears it. */
      due: DaySchema.nullable().optional(),
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
            /** Task box text for the child: what to do. */
            text: z.string().trim().min(1).max(20_000),
            /** The repos the child changes. Default: none. */
            repos: TaskReposSchema.optional(),
            /** Positions of earlier children this one waits for. */
            dependsOn: z.array(z.number().int().min(0).max(19)).max(20).default([]),
            /** When a dependency counts as met. `ready` stacks this child's branch on the dependency's. */
            when: z.enum(["merged", "ready"]).optional(),
            agent: IdSchema.optional(),
            /** Upload ids, or paths of files in your own task folder (like attachments/image.png). */
            attachments: z
              .array(z.string())
              .max(20)
              .default([])
              .describe(
                "Files to attach: an upload id, or the path of a file in your own task folder like attachments/image.png",
              ),
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
    summary:
      "Mark a task done. Worktrees stay until removed. Refused while a repo has commits that are not merged, pushed or in a pull request, unless the owner confirms with unshipped: keep. An agent can never close such a task",
    input: z.object({
      id: TaskIdSchema,
      /** The owner confirmed closing with work not shipped: the commits stay on the branch. Agents are refused anyway. */
      unshipped: UnshippedChoiceSchema.optional(),
    }),
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
      "Merge the task branch into a local branch in the project's checkout: its base by default, or any other (dev, staging). With push, then push that branch to the project's MR remote, never forced: refused before merging when the remote's copy has commits the local branch lacks. With done, mark the task done after a clean merge (and push). method picks a merge commit, one squashed commit, or a rebase of the task branch and a fast-forward; the target is never rewritten, and a conflict changes nothing. With deleteAfter, a clean run removes the worktree and the local branch majhi created",
    input: z.object({
      id: TaskIdSchema,
      /** The branch to merge into. Default: each repo's base branch. With repos on different bases, only repos whose base it is. */
      into: LocalBranchSchema.optional(),
      /** The branch to merge into, per repo. Wins over into. */
      targets: ShipTargetsSchema.optional(),
      /** Only this repo of the task. Default: every repo with changes. */
      project: IdSchema.optional(),
      done: z.boolean().default(false),
      /** Push the merged branch afterwards. */
      push: z.boolean().default(false),
      /** Owner only. With push: also send local commits on the target that the remote lacks and are not the task's. */
      pushLocalCommits: z.boolean().default(false),
      /** Owner only. With push: create the target branch on the remote when it has none. */
      createRemoteBranch: z.boolean().default(false),
      /** Owner only. A protected repo ships only alone (project set to it) with its name typed here. */
      confirmProtected: z.string().optional(),
      /** Default `merge`: fast-forward when it can, else a merge commit. */
      method: MergeMethodSchema.optional(),
      /** After a clean merge (and push), remove the worktree and delete the local branch majhi created. */
      deleteAfter: z.boolean().default(false),
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
  "tasks.updateTarget": {
    risk: "change",
    summary:
      "Owner only. Fetch the MR remote's copy of a target branch and fast-forward the owner's local branch of the same name to it, in the project's checkout. Only when the local branch has no commit the remote lacks; where the branch is checked out, only when no incoming file has uncommitted changes and no untracked path is in the way. Never forced, never a reset, no other branch moves. Refused with the reason otherwise",
    input: z.object({
      id: TaskIdSchema,
      /** The branch to update. Default: each repo's base branch. */
      into: LocalBranchSchema.optional(),
      /** The branch to update, per repo. Wins over into. */
      targets: ShipTargetsSchema.optional(),
      /** Only this repo of the task. Default: every repo with changes. */
      project: IdSchema.optional(),
    }),
    output: z.object({ results: z.array(MergeResultSchema) }),
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
      "Push the task branch of each repo to its MR remote (through the project's SSH alias), with no merge request. Never forced: a remote branch that moved is refused. With deleteAfter, a clean push removes the worktree and the local branch majhi created; the remote branch stays",
    input: z.object({ id: TaskIdSchema, deleteAfter: z.boolean().default(false) }),
    output: z.object({ results: z.array(MergeResultSchema), task: TaskSchema }),
  },
  "tasks.resolveShip": {
    risk: "outbound",
    summary:
      "A merge (or merge and push) stopped on conflicts: ask the task's lead to bring the target into the task branch, resolve the conflicts, run the checks and commit, then run that same ship by itself when the lead's turn ends and the branch merges cleanly. It runs once; if it still cannot, the task goes back to review with the reason. A done task is opened again first",
    input: z.object({
      id: TaskIdSchema,
      action: z.enum(["merge", "mergePush"]),
      into: LocalBranchSchema.optional(),
      /** The branch to merge into, per repo. Wins over into. */
      targets: ShipTargetsSchema.optional(),
      method: MergeMethodSchema.default("merge"),
      deleteAfter: z.boolean().default(false),
    }),
    output: z.object({ task: TaskSchema }),
  },
  "tasks.cancelShip": {
    risk: "change",
    summary: "Forget the ship majhi was to run once the lead resolves the conflicts. The lead keeps working",
    input: z.object({ id: TaskIdSchema }),
    output: z.object({ task: TaskSchema }),
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
      /** The branch the merge requests go into, per repo. Wins over into. */
      targets: ShipTargetsSchema.optional(),
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
  "tasks.changeBranch": {
    risk: "change",
    summary:
      "Commit file changes to another task's branch inside that task's own worktree, so its files, index and branch stay in step. Give base, the commit of that branch you read from (git rev-parse <branch> before reading); a branch that moved since is refused and nothing is written. Send a patch (unified diff from the repo root) for small edits, or whole files (path from the repo root, full new content) for new files and full rewrites, never both. Only for a task in your own org (root agents: any). Refused while one of its agents is working or has work queued (retry when it is idle, paused or in review), and while its worktree has uncommitted changes. The task's room gets a line saying who changed what and why",
    input: ChangeBranchInputSchema,
    output: ChangeBranchResultSchema,
  },
  "tasks.remove": {
    risk: "destructive",
    summary:
      "Delete a task, its folder and its worktrees. Refused when a worktree has uncommitted changes, unless force with confirm: the task id, typed by the owner after seeing the list of changes",
    input: z.object({
      id: TaskIdSchema,
      force: z.boolean().optional(),
      /** With force over uncommitted changes: the task id, typed by the owner. */
      confirm: z.string().max(40).optional(),
    }),
    output: z.object({ removed: TaskIdSchema }),
  },

  // Uploads -----------------------------------------------------------------
  "uploads.create": {
    risk: "read",
    summary:
      "Turn a file in your own task folder into an upload id you can pass in attachments (tasks.create, tasks.split). Takes a path like attachments/image.png. Copies the file; the original stays. Uploads are kept for 24 hours",
    input: z.object({
      /** Relative to your task folder, or absolute inside it. */
      path: z.string().trim().min(1).max(1000),
    }),
    output: AttachmentSchema,
  },

  // Room --------------------------------------------------------------------
  "room.send": {
    risk: "change",
    summary: "Send a message to the task's agent. Queued while it works, unless interrupt",
    input: z.object({
      task: TaskIdSchema,
      text: z.string().max(100_000),
      /**
       * Upload ids (from POST /api/uploads or uploads.create), or paths of files in your own task
       * folder, like attachments/image.png. A path is copied; the original stays.
       */
      attachments: z
        .array(z.string())
        .max(20)
        .default([])
        .describe(
          "Files to attach: an upload id, or the path of a file in your own task folder like attachments/image.png (copied, the original stays)",
        ),
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
  "room.sendNow": {
    risk: "change",
    summary: "Send a queued message now: stops its agent's current turn and sends this message first",
    input: z.object({ task: TaskIdSchema, item: z.string().min(1).max(200) }),
    output: z.object({ item: RoomItemSchema }),
  },
  "room.unqueue": {
    risk: "change",
    summary: "Remove a queued message before it is sent. The agent never gets it",
    input: z.object({ task: TaskIdSchema, item: z.string().min(1).max(200) }),
    output: z.object({ item: RoomItemSchema }),
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
  "room.search": {
    risk: "read",
    summary:
      "Full-text search over the messages, handoffs, system lines and tool output of every task's room, best match first",
    input: RoomSearchInputSchema,
    output: z.array(RoomSearchHitSchema),
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
      /** For merge, mergePush and mr: the target per repo. Wins over into. */
      targets: ShipTargetsSchema.optional(),
      /** For merge and mergePush. Default `merge`. */
      method: MergeMethodSchema.optional(),
      /** For merge, mergePush and push: delete the worktree and local branch after a clean run. */
      deleteAfter: z.boolean().optional(),
      /** For mergePush: the owner confirmed sending local commits on the target that are not the task's. */
      pushLocalCommits: z.boolean().optional(),
      /** For mergePush: the owner confirmed creating the target branch on the remote. */
      createRemoteBranch: z.boolean().optional(),
      /** For done: the owner confirmed closing with work not shipped. */
      unshipped: UnshippedChoiceSchema.optional(),
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

  // Connections (5.14) ---------------------------------------------------------
  "connections.types": {
    risk: "read",
    summary:
      "The connection types (kubectl, mcp, ssh, env, mail, browser) and the fields of each: key, kind (secret, text or file), the variable it maps to, whether it is required, and when it counts",
    input: Empty,
    output: z.array(ConnectionTypeDefSchema),
  },
  "connections.list": {
    risk: "read",
    summary:
      "List connections, of one org or all: type, name, description, which values are set, problems, the agents that list it and the last Test. Never returns a secret",
    input: z.object({ org: IdSchema.optional() }),
    output: z.array(ConnectionViewSchema),
  },
  "connections.get": {
    risk: "read",
    summary: "Show one connection. Text values are shown; for secrets and files only whether each is set",
    input: ById,
    output: ConnectionViewSchema,
  },
  "connections.create": {
    risk: "change",
    summary:
      "Add a connection to an org: its type, a name, a description (what agents see) and its text values, plus the variables, headers or env entries the type takes. Secrets go through connections.setSecret and files through connections.setFile. connections.types lists the fields. The id is derived from the name when not given, and is unique across orgs",
    input: ConnectionCreateInputSchema,
    output: ConnectionViewSchema,
  },
  "connections.update": {
    risk: "change",
    summary:
      "Edit a connection's name, description or text values (null clears one). A vars, headers or env list given replaces the old one, and an entry left out is deleted with its secret or file",
    input: ConnectionUpdateInputSchema,
    output: ConnectionViewSchema,
  },
  "connections.remove": {
    risk: "destructive",
    summary:
      "Remove a connection. Deletes its files and the secrets nothing else uses, and takes it off the agents that list it",
    input: ById,
    output: z.object({ removed: IdSchema }),
  },
  "connections.setSecret": {
    risk: "change",
    summary:
      "Set a secret field or entry of a connection: the value from the owner's secure input, or a secret: reference already in secrets.age (agents pass only references, from a secret request). The value is stored in secrets.age and never returned",
    input: ConnectionSetSecretInputSchema,
    output: ConnectionViewSchema,
  },
  "connections.setFile": {
    risk: "change",
    summary:
      "Set a file field or entry of a connection, like a kubeconfig, from an upload id (the page's upload, or uploads.create for a file in your task folder). It is kept owner-only in ~/.majhi/connections/<id>/",
    input: ConnectionSetFileInputSchema,
    output: ConnectionViewSchema,
  },
  "connections.allow": {
    risk: "destructive",
    summary:
      "Set the exact write actions the org allows on a connection without asking the owner, like `kubectl rollout restart deployment/api`. Agents then change things unasked, so it always needs the owner. An empty list asks for every write",
    input: z.object({ id: IdSchema, allow: z.array(z.string().trim().min(1).max(500)).max(200) }),
    output: ConnectionViewSchema,
  },
  "connections.test": {
    risk: "read",
    summary:
      "Test a connection the way a run would reach it: kubectl auth can-i --list, an MCP server's tool list, an SSH login, the env test command, an IMAP login and the SMTP greeting, or the browser MCP server starting. Warns when a kubectl identity can change things. Never shows a secret",
    input: ById,
    output: ConnectionTestResultSchema,
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
      "Change context budget, limits, resume, commits (agent attribution), room, memory, editor, cleanup or container limit settings (loop guard, review rounds, auto_threshold, review_all, housekeeper, housekeeper_model, editor.app: vscode or cursor, cleanup after_days, notifications (mac, browser, sound, muted kinds, quiet_from, quiet_to), container cpus, memory, per_task, weekly budgets: budgets.orgs.<org> or budgets.accounts.<account> as { tokens?, cost? }, null removes one). Policy changes use policy.set",
    input: z.object({
      context: ContextPatchSchema.optional(),
      limits: LimitsPatchSchema.optional(),
      resume: ResumePatchSchema.optional(),
      commits: CommitsPatchSchema.optional(),
      rooms: RoomPatchSchema.optional(),
      memory: MemoryPatchSchema.optional(),
      editor: EditorPatchSchema.optional(),
      cleanup: CleanupPatchSchema.optional(),
      notifications: NotificationsPatchSchema.optional(),
      containers: ContainersPatchSchema.optional(),
      budgets: BudgetsPatchSchema.optional(),
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
  "policy.cardStats": {
    risk: "read",
    summary:
      "How many approval cards each command put in front of the owner over the last days, and what came of them: approved, ran without asking, rejected, failed, still waiting",
    input: z.object({ days: z.number().int().min(1).max(90).default(14) }),
    output: ApprovalStatsSchema,
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

  "chats.create": {
    risk: "change",
    summary:
      "Start a chat with an agent, without a task. An untitled chat that was never written in is reused",
    input: z.object({ agent: IdSchema }),
    output: TaskSchema,
  },
  "chats.rename": {
    risk: "change",
    summary: "Rename a chat",
    input: z.object({ id: TaskIdSchema, title: z.string().trim().min(1).max(120) }),
    output: TaskSchema,
  },

  // Audit log ------------------------------------------------------------------
  "audit.list": {
    risk: "read",
    summary:
      "List the audit log, newest first: permission decisions, approvals, pushes, merge requests, merges and cleanups. Filter by org, task, kinds, agent, decision and a date range; page with before",
    input: AuditListInputSchema,
    output: AuditListSchema,
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
    summary:
      "Run every doctor check: config, mounts, SSH, CLIs, accounts, connections, disk, host helper. Connections show their last Test; connections.test tests one",
    input: Empty,
    output: z.object({
      checkedAt: z.string(),
      checks: z.array(
        z.object({
          id: z.string(),
          group: z.enum(["majhi", "host", "ssh", "accounts", "connections", "disk"]),
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
  "memory.edit": {
    risk: "change",
    summary:
      "Edit a fact's words, or move it to another scope (global, org:<id> or project:<id>). Logged with what changed",
    input: MemoryEditInputSchema,
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
  "usage.receipt": {
    risk: "read",
    summary:
      "Where one task's tokens went: the brief size at the start, recalled memory size, input, output and reasoning tokens, cache read and write and the cache hit rate, cost and its split per agent, compactions (before and after, native or handoff) and the decisions that replaced an LLM call. Sizes of what majhi added are estimated",
    input: z.object({ task: TaskIdSchema }),
    output: TaskReceiptSchema,
  },
  "usage.agentReceipt": {
    risk: "read",
    summary:
      "Where one agent's tokens went across tasks, for a range or the days from and to (inclusive): totals, cache hit rate, its most expensive tasks, compactions and decisions that replaced an LLM call",
    input: z.object({
      agent: IdSchema,
      range: UsageRangeSchema.default("month"),
      from: DaySchema.optional(),
      to: DaySchema.optional(),
      tz: TimeZoneSchema.optional(),
    }),
    output: AgentReceiptSchema,
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

  // Budgets (5.17, PRV-40) ------------------------------------------------------
  "budgets.status": {
    risk: "read",
    summary:
      "Each org and account with a weekly budget: used this week, the budget, percent, when the week started and resets, and the 80% and 100% alerts fired. Budgets are changed with settings.set",
    input: Empty,
    output: BudgetStatusSchema,
  },

  // Schedules (PRV-63) ----------------------------------------------------------
  "schedules.list": {
    risk: "read",
    summary: "List schedules with their next run time and last run result, optionally for one org",
    input: z.object({ org: IdSchema.optional() }),
    output: z.array(ScheduleViewSchema),
  },
  "schedules.get": {
    risk: "read",
    summary: "Show one schedule with its next run time and last run result",
    input: z.object({ id: ScheduleIdSchema }),
    output: ScheduleViewSchema,
  },
  "schedules.runs": {
    risk: "read",
    summary: "The run history of a schedule, newest first",
    input: z.object({ id: ScheduleIdSchema, limit: z.number().int().min(1).max(200).default(50) }),
    output: z.array(AutomationRunSchema),
  },
  "schedules.create": {
    risk: "change",
    summary:
      "Create a schedule that starts a task, posts to a task's room or runs a command, every N minutes, hours or days, by a cron expression, or once. Give a spec, or a phrase like 'weekdays at 9:00'. The time zone is the caller's, UTC when not sent",
    input: ScheduleCreateInputSchema,
    output: ScheduleViewSchema,
  },
  "schedules.update": {
    risk: "change",
    summary: "Edit a schedule's name, when it runs, its time zone, its action or its overlap rule",
    input: ScheduleUpdateInputSchema,
    output: ScheduleViewSchema,
  },
  "schedules.pause": {
    risk: "change",
    summary: "Pause a schedule: it does not run until it is resumed",
    input: z.object({ id: ScheduleIdSchema }),
    output: ScheduleViewSchema,
  },
  "schedules.resume": {
    risk: "change",
    summary: "Resume a paused schedule. Missed runs are not replayed",
    input: z.object({ id: ScheduleIdSchema }),
    output: ScheduleViewSchema,
  },
  "schedules.runNow": {
    risk: "change",
    summary:
      "Run a schedule's action now. The overlap rule applies: with skip, a run is recorded as skipped while the last one still goes",
    input: z.object({ id: ScheduleIdSchema }),
    output: AutomationRunSchema,
  },
  "schedules.delete": {
    risk: "destructive",
    summary: "Delete a schedule and its run history",
    input: z.object({ id: ScheduleIdSchema }),
    output: z.object({ removed: ScheduleIdSchema }),
  },

  // Watch triggers (PRV-63) -----------------------------------------------------
  "triggers.list": {
    risk: "read",
    summary:
      "List watch triggers with what they watch, their last check and last run result, optionally for one org",
    input: z.object({ org: IdSchema.optional() }),
    output: z.array(TriggerViewSchema),
  },
  "triggers.get": {
    risk: "read",
    summary: "Show one watch trigger with its last check and last run result",
    input: z.object({ id: TriggerIdSchema }),
    output: TriggerViewSchema,
  },
  "triggers.runs": {
    risk: "read",
    summary: "The run history of a watch trigger, newest first",
    input: z.object({ id: TriggerIdSchema, limit: z.number().int().min(1).max(200).default(50) }),
    output: z.array(AutomationRunSchema),
  },
  "triggers.create": {
    risk: "change",
    summary:
      "Create a watch trigger that starts a task, posts to a task's room or runs a command when something changes: a task's status (done, failed, needs you), a task's merge request, a branch, a file or folder in a project, a process exit, usage over a limit, a URL, or a command's output. settleSeconds is the quiet time a change must hold before it fires, cooldownSeconds the wait after a firing (default 300). {{event}} in the action's text becomes a line about what matched",
    input: TriggerCreateInputSchema,
    output: TriggerViewSchema,
  },
  "triggers.update": {
    risk: "change",
    summary:
      "Edit a watch trigger's name, what it watches, its action, its overlap rule, check interval, settle time or cooldown",
    input: TriggerUpdateInputSchema,
    output: TriggerViewSchema,
  },
  "triggers.pause": {
    risk: "change",
    summary: "Pause a watch trigger: it stops checking until it is resumed",
    input: z.object({ id: TriggerIdSchema }),
    output: TriggerViewSchema,
  },
  "triggers.resume": {
    risk: "change",
    summary: "Resume a paused watch trigger. Changes made while it was paused do not fire it",
    input: z.object({ id: TriggerIdSchema }),
    output: TriggerViewSchema,
  },
  "triggers.runNow": {
    risk: "change",
    summary:
      "Run a watch trigger's action now, as a test. The overlap rule applies; the cooldown and what the trigger watches are left alone",
    input: z.object({ id: TriggerIdSchema }),
    output: AutomationRunSchema,
  },
  "triggers.delete": {
    risk: "destructive",
    summary: "Delete a watch trigger and its run history",
    input: z.object({ id: TriggerIdSchema }),
    output: z.object({ removed: TriggerIdSchema }),
  },

  // Autonomous mode (PRV-74) ------------------------------------------------------
  "autonomy.status": {
    risk: "read",
    summary:
      "Autonomous mode now: off, on, paused or stopping; the autonomous tasks and what their agents do, the planned queue, today's spend against the day and org caps, each account's 5-hour and weekly windows, what holds new work, cards waiting for the owner, the settings and the newest daily summary",
    input: Empty,
    output: AutonomyStatusSchema,
  },
  "autonomy.events": {
    risk: "read",
    summary:
      "The autonomous feed, newest first: mode changes, ticks, decisions with their one-line reasons, approvals, refusals, task changes, answers, guidance and cap holds. decisions true keeps only decisions, approvals and refusals",
    input: AutonomyEventsInputSchema,
    output: z.object({ events: z.array(AutonomyEventSchema) }),
  },
  "autonomy.start": {
    risk: "change",
    summary: "Turn autonomous mode on, or resume it when paused. Owner only. Refused when there is no boss",
    input: Empty,
    output: AutonomyStatusSchema,
  },
  "autonomy.pause": {
    risk: "change",
    summary:
      "Pause autonomous mode: the boss gets no ticks and autonomous tasks pause after their current turn, until autonomy.start resumes them. Owner only",
    input: Empty,
    output: AutonomyStatusSchema,
  },
  "autonomy.stop": {
    risk: "change",
    summary:
      "Stop autonomous mode. now: stop every run of its tasks and the boss's autonomy turn at once. graceful: current turns finish, nothing new starts, then it turns off. Owner only",
    input: AutonomyStopInputSchema,
    output: AutonomyStatusSchema,
  },
  "autonomy.configure": {
    risk: "change",
    summary:
      "Change autonomous mode's day cap, org caps, per-org push and merge permission, account floors, summary time or time zone. Owner only",
    input: AutonomyPatchSchema,
    output: AutonomyStatusSchema,
  },
  "autonomy.guide": {
    risk: "change",
    summary:
      "Send the boss a message in its autonomy chat: guidance, or a question about what it is doing. keep also saves it as a standing instruction it follows from now on. Owner only",
    input: AutonomyGuideInputSchema,
    output: AutonomyGuideResultSchema,
  },
  "autonomy.forget": {
    risk: "change",
    summary: "Remove a standing instruction of autonomous mode. Owner only",
    input: z.object({ id: z.string().regex(/^[a-z0-9]{8}$/) }),
    output: AutonomyStatusSchema,
  },
  "autonomy.plan": {
    risk: "change",
    summary:
      "Autonomous mode only, for the boss: replace the queue of what you plan to do next, in order, each with a one-line why and an optional not-before time",
    input: AutonomyPlanInputSchema,
    output: z.object({ queue: z.number().int().nonnegative() }),
  },
  "autonomy.note": {
    risk: "change",
    summary:
      "Autonomous mode only, for the boss: log a decision that is not a call, in one line (waiting for an account's reset, skipping an org, leaving a task for the owner). unsure true puts it in the daily summary",
    input: AutonomyNoteInputSchema,
    output: z.object({ seq: z.number().int().positive() }),
  },
  "autonomy.answer": {
    risk: "change",
    summary:
      "Autonomous mode only, for the boss: answer a card in an autonomous task as the owner would. option for a permission prompt or a choice (the option id) or an owner question (the choice); answers for an ask card. Refused for connection writes, secret requests and approval cards",
    input: AutonomyAnswerInputSchema,
    output: AutonomyAnswerResultSchema,
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
  /**
   * The task the calling agent runs in. Set by majhi on the MCP and admin paths only; the HTTP
   * route drops it from the header, so an owner's call never has one.
   */
  task: z.string().optional(),
});
export type CommandMeta = z.infer<typeof CommandMetaSchema>;

/** Header carrying the JSON-encoded CommandMeta on `POST /api/cmd/<name>`. */
export const COMMAND_META_HEADER = "x-majhi-meta";
