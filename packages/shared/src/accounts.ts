import { z } from "zod";
import { AgentToolRefSchema } from "./agent-tools.ts";
import { ConnectionConfigSchema, duplicateConnectionIds } from "./connections.ts";
import { IdSchema, SecretRefSchema } from "./ids.ts";
import { AttentionEventSchema } from "./notify.ts";
import { CommitsPatchSchema, ContextPatchSchema, ResumePatchSchema, RoomPatchSchema } from "./settings.ts";
import { RoleSchema, TierPatchSchema, TiersPatchSchema } from "./tiers.ts";

/**
 * Accounts, orgs, tools and agents (SPEC 2, 3.3, 4.4, 5.1, 5.2, 5.8).
 *
 * Files on disk:
 *   ~/.majhi/majhi.yaml          `accounts:` and `orgs:` sections
 *   ~/.majhi/accounts/<id>/      one CLI config home per account (git-ignored)
 *   ~/.majhi/agents/<id>.md      one agent per file, YAML frontmatter + instructions
 *   ~/.majhi/secrets.age         API keys, encrypted with age (git-ignored)
 */

// In their own module so connections.ts can use them without importing this file.
export { IdSchema, type SecretRef, SecretRefSchema } from "./ids.ts";

/**
 * The built-in org for the owner's own accounts and projects. It always exists, even
 * without an entry in `orgs`, and cannot be removed or reused as a new org id.
 */
export const PRIVATE = "private";
/** Display name of the built-in org. */
export const PRIVATE_NAME = "Private";
/** Default task key prefix of the built-in org. */
export const PRIVATE_KEY = "PRV";
/** Neutral dot color of the built-in org. */
export const PRIVATE_COLOR = "#8a8f98";
/** The old id of the built-in org. Still read as `private`, and rewritten by the startup migration. */
export const LEGACY_PERSONAL = "personal";

/** Reads the old `personal` org id as `private`. Every other id is unchanged. */
export function currentOrgId(id: string): string {
  return id === LEGACY_PERSONAL ? PRIVATE : id;
}

/** An org id as written in a file. An old `personal` reads as `private`. */
export const OrgIdSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}$/,
    "Use lowercase letters, digits and dashes, starting with a letter or digit",
  )
  .transform(currentOrgId);

/** Git hosts majhi can open and merge MRs on (5.5). Other hosts get a push and no MR. */
export const MrHostSchema = z.enum(["github", "gitlab", "bitbucket"]);
export type MrHost = z.infer<typeof MrHostSchema>;

/** When majhi merges an org's MRs (5.5). */
export const MergePolicySchema = z.enum(["never", "approve", "auto-if-green"]);
export type MergePolicy = z.infer<typeof MergePolicySchema>;
export const DEFAULT_MERGE_POLICY: MergePolicy = "never";

/** Which tasks a lead may start on its own: its subtasks, any task of the org, or none (5.4a). */
export const LeadStartSchema = z.enum(["children", "org", "off"]);
export type LeadStart = z.infer<typeof LeadStartSchema>;
export const DEFAULT_LEAD_START: LeadStart = "children";

/** Agent CLIs majhi drives over ACP. Adding a tool is one entry here plus one in `packages/acp` tools. */
export const ToolIdSchema = z.enum(["claude", "codex"]);
export type ToolId = z.infer<typeof ToolIdSchema>;

export const AuthModeSchema = z.enum(["login", "api-key"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

// ---------------------------------------------------------------------------
// majhi.yaml sections

/** The SSH route value that means the host's own default key, not a `~/.ssh/config` alias. */
export const DEFAULT_SSH_ROUTE = "default";

/**
 * One spelling for an SSH route: the host name itself (`gitlab.com`, as the project route picker
 * saves it) and `default` both mean the host's default key and become `default`. An alias stays.
 */
export function normalizeSshRoute(host: string, ssh: string | undefined): string | undefined {
  if (ssh === undefined) return undefined;
  const value = ssh.trim();
  if (value === "") return undefined;
  const lower = value.toLowerCase();
  return lower === DEFAULT_SSH_ROUTE || lower === host.trim().toLowerCase() ? DEFAULT_SSH_ROUTE : value;
}

/**
 * Whether a detected login is the SSH route an account names: `default` is the host's own key (no
 * alias), an alias is that alias, and no route at all takes any SSH key.
 */
export function sshRouteMatches(
  route: string | undefined,
  login: { via: string; alias?: string | undefined },
): boolean {
  if (login.via !== "ssh") return false;
  if (route === undefined) return true;
  return route === DEFAULT_SSH_ROUTE ? login.alias === undefined : login.alias === route;
}

/** One git account an org pushes and opens MRs as on one host. */
export const GitAccountSchema = z
  .strictObject({
    /** The git host name, like `gitlab.com`. */
    host: z.string().trim().toLowerCase().min(1).max(255),
    account: z.string().trim().min(1).max(255),
    /**
     * The SSH route: `default` for the host's default key, a `Host` alias, or absent for any key
     * that logs in as the account. The host name is read and written as `default`.
     */
    ssh: z.string().trim().min(1).max(255).optional(),
    /** The account's own token for MRs and the API. */
    token: SecretRefSchema.optional(),
  })
  .transform(
    ({ ssh, ...rest }): { host: string; account: string; ssh?: string; token?: string | undefined } => {
      const route = normalizeSshRoute(rest.host, ssh);
      return route === undefined ? rest : { ...rest, ssh: route };
    },
  );
export type GitAccount = z.infer<typeof GitAccountSchema>;

/** A detected login the owner said No to for one org, so it is not offered there again. */
export const DismissedLoginSchema = z.strictObject({
  host: z.string().trim().toLowerCase().min(1).max(255),
  account: z.string().trim().min(1).max(255),
});
export type DismissedLogin = z.infer<typeof DismissedLoginSchema>;

export const OrgConfigSchema = z.looseObject({
  name: z.string().trim().min(1),
  /** Hex color used for the org's dot and badges. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** Default base branch for the org's repos. */
  base: z.string().trim().min(1).optional(),
  /** Task key prefix, like `GLX` for `GLX-420`. Default: derived from the name. */
  key: z
    .string()
    .regex(/^[A-Z][A-Z0-9]{0,9}$/, "Use 1 to 10 capital letters or digits, starting with a letter")
    .refine((k) => k !== "LOCAL", "LOCAL is reserved for tasks without an org")
    .optional(),
  /** Who commits made in this org's repos are authored as. */
  identity: z
    .object({
      name: z.string().trim().min(1, "Give the commit name"),
      email: z.email("Use an email address like you@company.com"),
    })
    .optional(),
  /** Overrides the majhi-wide context budget for this org's agents (5.13). */
  context: ContextPatchSchema.pick({ compact_at: true }).optional(),
  /** Overrides whether this org's runs resume on their own (5.7). */
  resume: ResumePatchSchema.optional(),
  /** Overrides whether this org's commits name the agent and the task (5.7). */
  commits: CommitsPatchSchema.optional(),
  /** Overrides the loop guard for this org's tasks (5.3). */
  rooms: RoomPatchSchema.pick({ max_agent_turns: true }).optional(),
  /** Overrides the model and effort tiers of `decisions.tiers` for this org's agents (5.12). */
  tiers: TiersPatchSchema.optional(),
  /** The default team for new tasks, lead first. Absent: the decision provider picks one (Phase 3). */
  team: z.array(IdSchema).optional(),
  /** When majhi merges the org's MRs (5.5). Absent: `never`. */
  merge: MergePolicySchema.optional(),
  /** Which tasks a lead may start without asking the owner. Absent: `children`. */
  lead_start: LeadStartSchema.optional(),
  /** Credentials for opening and merging MRs, one secret per host. A project remote's own `token` wins. */
  mr_tokens: z.partialRecord(MrHostSchema, SecretRefSchema).optional(),
  /** The git accounts of this org per host. They decide the push key, token and commit identity. */
  git_accounts: z.array(GitAccountSchema).optional(),
  /** Detected logins the owner declined for this org. */
  dismissed_logins: z.array(DismissedLoginSchema).optional(),
  /** The clusters, MCP servers, hosts and accounts this org's agents may reach (5.14), by id. */
  connections: z.record(IdSchema, ConnectionConfigSchema).optional(),
});
export type OrgConfig = z.infer<typeof OrgConfigSchema>;

/** `orgs` in majhi.yaml. A connection id is unique across orgs: it names the folder of the connection's files. */
export const OrgsConfigSchema = z.record(IdSchema, OrgConfigSchema).superRefine((orgs, ctx) => {
  for (const { id, orgs: owners } of duplicateConnectionIds(orgs)) {
    ctx.addIssue({
      code: "custom",
      path: [owners[1] ?? id, "connections", id],
      message: `Connection ${id} is in both ${owners.join(" and ")}. A connection id is unique across orgs.`,
    });
  }
});

export const AccountConfigSchema = z
  .strictObject({
    tool: ToolIdSchema,
    /** An org id from `orgs`, or `private`. */
    org: OrgIdSchema,
    auth: AuthModeSchema,
    /** Required for `api-key` accounts, absent for `login`. */
    key: SecretRefSchema.optional(),
    /** Model ids the owner hid: left out of `auto` picks and fallback tiers. An agent that names one still gets it. */
    hidden_models: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((a) => (a.auth === "api-key") === (a.key !== undefined), {
    message: "API-key accounts need `key: secret:<name>`; login accounts must not have one",
    path: ["key"],
  });
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

// ---------------------------------------------------------------------------
// Agent files

export const PermSchema = z.enum(["edit", "shell", "push", "mr", "merge"]);
export type Perm = z.infer<typeof PermSchema>;

/** `auto` lets the decision provider pick (5.12). Any other value is an id from the account's ACP option list. */
export const AUTO = "auto";

/** Frontmatter of `~/.majhi/agents/<id>.md`. The file name must equal `<id>.md`. */
export const AgentFrontmatterSchema = z.strictObject({
  id: IdSchema,
  /** An org id, or `root`. */
  scope: OrgIdSchema,
  role: RoleSchema,
  account: IdSchema,
  /** A model id from the account's ACP model list, or `auto`. Absent means the agent's ACP default. */
  model: z.string().trim().min(1).optional(),
  /** An effort id from the account's ACP effort list, or `auto`. Absent means the ACP default. */
  effort: z.string().trim().min(1).optional(),
  /** Fallback tiers for this agent when `model` or `effort` is `auto` and there is no confident pick. */
  tier: TierPatchSchema.optional(),
  /** Allowed model ids when `model` is `auto`. Empty means every model the account offers. */
  models: z.array(z.string().trim().min(1)).optional(),
  /** Org ids the agent may work in, or `[anywhere]`. */
  where: z.array(OrgIdSchema).min(1).default(["anywhere"]),
  perms: z.array(PermSchema).default([]),
  tools: z.array(AgentToolRefSchema).default([]),
  connections: z.array(IdSchema).default([]),
  skills: z.array(z.string().trim().min(1)).default([]),
  fallback: IdSchema.optional(),
  context: z
    .strictObject({
      compact_at: z.number().gt(0).lt(1).optional(),
    })
    .optional(),
  origin: z.enum(["setup", "owner"]).default("owner"),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;
/** What callers send: defaults not yet applied. */
export type AgentFrontmatterInput = z.input<typeof AgentFrontmatterSchema>;

/**
 * May this agent work in the org? Root agents go where their `where` says. An org agent
 * works in its own org, and in another only when `where` names it. A task without an org
 * (`org` undefined) is for root agents.
 */
export function canWorkIn(
  agent: { scope: string; where: readonly string[] },
  org: string | undefined,
): boolean {
  const anywhere = agent.where.includes("anywhere");
  if (org === undefined) return agent.scope === "root" && anywhere;
  if (agent.scope === "root") return anywhere || agent.where.includes(org);
  if (agent.scope === org) return anywhere || agent.where.includes(org);
  return agent.where.includes(org);
}

export const AgentSchema = z.object({
  frontmatter: AgentFrontmatterSchema,
  /** Markdown body after the frontmatter. */
  instructions: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** One entry from `~/.majhi/agents/`. Broken files are listed with their errors, never dropped. */
export const AgentEntrySchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    file: z.string(),
    agent: AgentSchema,
    /** Problems that do not stop the file loading: unknown account, model no longer offered. */
    warnings: z.array(z.string()),
    isBoss: z.boolean(),
  }),
  z.object({
    status: z.literal("invalid"),
    file: z.string(),
    /** From the file name, so the entry can still be shown and fixed. */
    id: z.string(),
    errors: z.array(z.string()).min(1),
  }),
]);
export type AgentEntry = z.infer<typeof AgentEntrySchema>;

// ---------------------------------------------------------------------------
// Tools, models, health

export const ToolInfoSchema = z.object({
  id: ToolIdSchema,
  /** Display name: "Claude Code", "Codex". */
  name: z.string(),
  authModes: z.array(AuthModeSchema),
  /** One line shown above the login terminal. */
  loginHint: z.string(),
  /** Name of the API key, for the paste field: "Anthropic API key". */
  apiKeyLabel: z.string(),
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** One value of an ACP session config option (category `model` or `thought_level`). */
export const OptionValueSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type OptionValue = z.infer<typeof OptionValueSchema>;

/** Models and effort levels one account offers, read over ACP and cached per account (5.1). */
export const AccountModelsSchema = z.object({
  account: IdSchema,
  models: z.array(OptionValueSchema),
  efforts: z.array(OptionValueSchema),
  defaultModel: z.string().optional(),
  defaultEffort: z.string().optional(),
  fetchedAt: z.string(),
});
export type AccountModels = z.infer<typeof AccountModelsSchema>;

export const HealthStepSchema = z.object({
  /** `cli`: the tool starts. `auth`: credentials are present. `acp`: an ACP session opens. `model`: the agent's model is offered. */
  name: z.enum(["cli", "auth", "acp", "model"]),
  ok: z.boolean(),
  /** One line: a version, an email, an error. Never a secret. */
  detail: z.string(),
});
export type HealthStep = z.infer<typeof HealthStepSchema>;

/** Result of a health check. Spends no model tokens. */
export const HealthCheckSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.string(),
  durationMs: z.number(),
  steps: z.array(HealthStepSchema),
});
export type HealthCheck = z.infer<typeof HealthCheckSchema>;

export const AccountStatusSchema = z.enum([
  "unknown",
  "healthy",
  "needs-login",
  "running-high",
  "at-limit",
  "relogin-soon",
  "unreachable",
]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const UsageWindowSchema = z.object({
  usedPct: z.number().min(0),
  resetsAt: z.string().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

export const ModelUsageWindowSchema = UsageWindowSchema.extend({
  /** Model name as the tool shows it, like "Opus" or "Sonnet". */
  label: z.string(),
});
export type ModelUsageWindow = z.infer<typeof ModelUsageWindowSchema>;

export const AccountUsageSchema = z.object({
  /** Subscription plan as the tool reports it: "max", "plus", "pro". */
  plan: z.string().optional(),
  /** The current short window (5 hours for Claude and Codex today). */
  window: UsageWindowSchema.optional(),
  weekly: UsageWindowSchema.optional(),
  /** Weekly windows scoped to one model, like Opus or Sonnet. */
  models: z.array(ModelUsageWindowSchema).default([]),
  /** Why the last read failed. The numbers above are then from the last good read. */
  error: z.string().optional(),
  /** True when majhi counted tokens itself because the CLI did not report usage (5.8). */
  estimated: z.boolean(),
  updatedAt: z.string(),
});
export type AccountUsage = z.infer<typeof AccountUsageSchema>;

export const AccountViewSchema = z.object({
  id: IdSchema,
  tool: ToolIdSchema,
  org: IdSchema,
  auth: AuthModeSchema,
  /** Absolute path of the account's config home. */
  home: z.string(),
  /** Models hidden from `auto` picks. */
  hiddenModels: z.array(z.string()).default([]),
  agentCount: z.number().int().nonnegative(),
  status: AccountStatusSchema,
  /** From the last health check, like the signed-in email. */
  signedInAs: z.string().optional(),
  lastHealth: HealthCheckSchema.optional(),
  usage: AccountUsageSchema.optional(),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const OrgViewSchema = z.object({
  id: IdSchema,
  name: z.string(),
  color: z.string().optional(),
  base: z.string().optional(),
  /** The task key prefix: the configured `key`, else the one derived from the name. */
  key: z.string(),
  identity: OrgConfigSchema.shape.identity,
  /** This org's own `compact_at`, when it overrides majhi's. */
  context: OrgConfigSchema.shape.context,
  /** This org's own `resume.auto`, when it overrides majhi's. */
  resume: OrgConfigSchema.shape.resume,
  /** This org's own `commits.attribution`, when it overrides majhi's. */
  commits: OrgConfigSchema.shape.commits,
  /** This org's own loop guard, when it overrides majhi's. */
  rooms: OrgConfigSchema.shape.rooms,
  /** This org's own fallback tiers, when it overrides majhi's. */
  tiers: OrgConfigSchema.shape.tiers,
  /** The default team for new tasks, when set. */
  team: OrgConfigSchema.shape.team,
  /** The merge policy in force: the org's `merge`, else `never`. */
  merge: MergePolicySchema,
  /** The lead-start setting in force: the org's `lead_start`, else `children`. */
  leadStart: LeadStartSchema,
  /** Secret references (never values) for the MR hosts, when set. */
  mrTokens: OrgConfigSchema.shape.mr_tokens,
  gitAccounts: OrgConfigSchema.shape.git_accounts,
  accountCount: z.number().int().nonnegative(),
  agentCount: z.number().int().nonnegative(),
});
export type OrgView = z.infer<typeof OrgViewSchema>;

// ---------------------------------------------------------------------------
// Live channels (WebSocket)

/**
 * `GET /api/events` (WebSocket). The server sends one message whenever a topic
 * changes, from a command or from a hand edit picked up by a file watcher. The
 * client refetches the queries for those topics.
 */
export const EventTopicSchema = z.enum([
  "config",
  "orgs",
  "accounts",
  "agents",
  "projects",
  "tasks",
  "secrets",
  "usage",
  "memory",
  "containers",
  "schedules",
  "triggers",
  "budgets",
  "connections",
  "autonomy",
]);
export type EventTopic = z.infer<typeof EventTopicSchema>;
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), topics: z.array(EventTopicSchema).min(1) }),
  AttentionEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;

/**
 * `GET /api/term/<terminalId>` (WebSocket). One login terminal, started by
 * `accounts.login.start`. Output is sent as it arrives; late joiners first get
 * the buffered output. The terminal ends when the login command exits, and is
 * removed 60 seconds later.
 */
export const TerminalClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string().max(64 * 1024) }),
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(10).max(500),
    rows: z.number().int().min(4).max(200),
  }),
]);
export type TerminalClientMessage = z.infer<typeof TerminalClientMessageSchema>;

export const TerminalServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("output"), data: z.string() }),
  /** Login finished. `health` is the account check run right after a zero exit. */
  z.object({ type: z.literal("exit"), code: z.number().int(), health: HealthCheckSchema.optional() }),
]);
export type TerminalServerMessage = z.infer<typeof TerminalServerMessageSchema>;
