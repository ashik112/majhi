import { z } from "zod";

/**
 * Accounts, orgs, tools and agents (SPEC 2, 3.3, 4.4, 5.1, 5.2, 5.8).
 *
 * Files on disk:
 *   ~/.majhi/majhi.yaml          `accounts:` and `orgs:` sections
 *   ~/.majhi/accounts/<id>/      one CLI config home per account (git-ignored)
 *   ~/.majhi/agents/<id>.md      one agent per file, YAML frontmatter + instructions
 *   ~/.majhi/secrets.age         API keys, encrypted with age (git-ignored)
 */

/** Lowercase id used for accounts, orgs and agents: `claude-acme-2`, `globex`, `majhi-boss`. */
export const IdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "Use lowercase letters, digits and dashes, starting with a letter or digit");

/** Accounts not owned by an org. Never a valid org id. */
export const PERSONAL = "personal";

/** Reference to an entry in `secrets.age`, like `secret:anthropic-personal`. */
export const SecretRefSchema = z.string().regex(/^secret:[a-z0-9][a-z0-9-]{0,62}$/, "Use secret:<name>");
export type SecretRef = z.infer<typeof SecretRefSchema>;

/** Agent CLIs majhi drives over ACP. Adding a tool is one entry here plus one in `packages/acp` tools. */
export const ToolIdSchema = z.enum(["claude", "codex"]);
export type ToolId = z.infer<typeof ToolIdSchema>;

export const AuthModeSchema = z.enum(["login", "api-key"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

// ---------------------------------------------------------------------------
// majhi.yaml sections

export const OrgConfigSchema = z.looseObject({
  name: z.string().trim().min(1),
  /** Hex color used for the org's dot and badges. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  /** Default base branch for the org's repos. */
  base: z.string().trim().min(1).optional(),
});
export type OrgConfig = z.infer<typeof OrgConfigSchema>;

export const AccountConfigSchema = z
  .strictObject({
    tool: ToolIdSchema,
    /** An org id from `orgs`, or `personal`. */
    org: IdSchema,
    auth: AuthModeSchema,
    /** Required for `api-key` accounts, absent for `login`. */
    key: SecretRefSchema.optional(),
  })
  .refine((a) => (a.auth === "api-key") === (a.key !== undefined), {
    message: "API-key accounts need `key: secret:<name>`; login accounts must not have one",
    path: ["key"],
  });
export type AccountConfig = z.infer<typeof AccountConfigSchema>;

// ---------------------------------------------------------------------------
// Agent files

export const RoleSchema = z.enum(["Lead", "Builder", "Reviewer", "Tester", "Root"]);
export type Role = z.infer<typeof RoleSchema>;

export const PermSchema = z.enum(["edit", "shell", "push", "mr", "merge"]);
export type Perm = z.infer<typeof PermSchema>;

/** `auto` lets the decision provider pick (5.12). Any other value is an id from the account's ACP option list. */
export const AUTO = "auto";

/** Frontmatter of `~/.majhi/agents/<id>.md`. The file name must equal `<id>.md`. */
export const AgentFrontmatterSchema = z.strictObject({
  id: IdSchema,
  /** An org id, or `root`. */
  scope: IdSchema,
  role: RoleSchema,
  account: IdSchema,
  /** A model id from the account's ACP model list, or `auto`. Absent means the agent's ACP default. */
  model: z.string().trim().min(1).optional(),
  /** An effort id from the account's ACP effort list, or `auto`. Absent means the ACP default. */
  effort: z.string().trim().min(1).optional(),
  /** Allowed model ids when `model` is `auto`. Empty means every model the account offers. */
  models: z.array(z.string().trim().min(1)).optional(),
  /** Org ids the agent may work in, or `[anywhere]`. */
  where: z.array(IdSchema).min(1).default(["anywhere"]),
  perms: z.array(PermSchema).default([]),
  tools: z.array(IdSchema).default([]),
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

export const AccountUsageSchema = z.object({
  /** The current short window (5 hours for Claude and Codex today). */
  window: UsageWindowSchema.optional(),
  weekly: UsageWindowSchema.optional(),
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
export const EventTopicSchema = z.enum(["config", "orgs", "accounts", "agents"]);
export type EventTopic = z.infer<typeof EventTopicSchema>;
export const ServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("changed"), topics: z.array(EventTopicSchema).min(1) }),
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
