import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountUsage, ModelUsageWindow } from "@majhi/shared";
import { z } from "zod";
import { SignInExpired } from "../auth-failure.ts";
import { execTool } from "../tool-process.ts";
import { CLAUDE_USAGE_SCRIPT } from "./claude-usage-helper.ts";
import type { AccountIdentity, ContextCap, LimitShapes, ToolDef, UsageContext } from "./types.ts";

const AuthStatusJson = z.looseObject({
  loggedIn: z.boolean().optional(),
  email: z.string().optional(),
  orgName: z.string().optional(),
  subscriptionType: z.string().optional(),
  apiKeySource: z.string().optional(),
});

const Window = z
  .looseObject({ utilization: z.number().nullable(), resets_at: z.string().nullable() })
  .nullish();

/** What the helper prints. Only the fields majhi reads are required. */
const UsageJson = z.looseObject({
  subscription_type: z.string().nullable().optional(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .looseObject({
      five_hour: Window,
      seven_day: Window,
      seven_day_opus: Window,
      seven_day_sonnet: Window,
      model_scoped: z
        .array(
          z.looseObject({
            display_name: z.string(),
            utilization: z.number().nullable(),
            resets_at: z.string().nullable(),
          }),
        )
        .nullish(),
    })
    .nullable(),
});

type ParsedWindow = z.infer<typeof Window>;

function toWindow(w: ParsedWindow) {
  if (w === null || w === undefined || w.utilization === null) return undefined;
  return {
    usedPct: Math.min(100, Math.max(0, w.utilization)),
    ...(w.resets_at === null ? {} : { resetsAt: w.resets_at }),
  };
}

/** Maps the helper's JSON to majhi's usage. Throws a one-line message when the shape or the plan does not fit. */
export function mapClaudeUsage(json: unknown, now: Date = new Date()): AccountUsage {
  const parsed = UsageJson.safeParse(json);
  if (!parsed.success) throw new Error("Claude reported usage in a shape majhi does not know");
  const { subscription_type, rate_limits_available, rate_limits } = parsed.data;
  // A login account with no plan at all: the CLI could not use its token. It tried to refresh it
  // and failed, or holds none any more (checked on Claude Code 2.1.284). `auth status` still says
  // signed in then, so this is the check that matches what a run needs.
  if (!rate_limits_available && !subscription_type) throw new SignInExpired();
  if (!rate_limits_available || rate_limits === null) {
    throw new Error("Claude reports no plan limits for this account");
  }
  const models: ModelUsageWindow[] = [];
  const add = (label: string, w: ParsedWindow) => {
    const window = toWindow(w);
    if (window === undefined) return;
    if (models.some((m) => m.label.toLowerCase() === label.toLowerCase())) return;
    models.push({ label, ...window });
  };
  for (const m of rate_limits.model_scoped ?? []) add(m.display_name, m);
  add("Opus", rate_limits.seven_day_opus);
  add("Sonnet", rate_limits.seven_day_sonnet);

  const usage: AccountUsage = { models, estimated: false, updatedAt: now.toISOString() };
  if (subscription_type) usage.plan = subscription_type;
  const window = toWindow(rate_limits.five_hour);
  if (window !== undefined) usage.window = window;
  const weekly = toWindow(rate_limits.seven_day);
  if (weekly !== undefined) usage.weekly = weekly;
  return usage;
}

async function readClaudeUsage(ctx: UsageContext): Promise<AccountUsage> {
  const helper = ctx.options.usage?.claude ?? {
    // In a runner container the host's node path does not exist; its PATH has node.
    command: ctx.options.spawner === undefined ? process.execPath : "node",
    args: [
      "--input-type=module",
      "-e",
      CLAUDE_USAGE_SCRIPT,
      ctx.adapter.command,
      String(Math.max(1000, ctx.timeoutMs - 2000)),
    ],
  };
  const res = await execTool(ctx.options, ctx.account, helper.command, helper.args, ctx.env, ctx.timeoutMs);
  if (res.error) throw new Error(res.error);
  if (res.code !== 0) {
    throw new Error(res.stderr.trim().split("\n").pop()?.trim() || `Usage read exited with code ${res.code}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    throw new Error("Claude reported usage in a shape majhi does not know");
  }
  return mapClaudeUsage(json);
}

const ClaudeCredentialsFile = z.looseObject({
  claudeAiOauth: z.looseObject({ expiresAt: z.number().optional() }).optional(),
});

async function claudeSignInExpiresAt(home: string): Promise<number | undefined> {
  try {
    const parsed = ClaudeCredentialsFile.safeParse(
      JSON.parse(await readFile(join(home, ".credentials.json"), "utf8")),
    );
    return parsed.success ? parsed.data.claudeAiOauth?.expiresAt : undefined;
  } catch {
    return undefined;
  }
}

/** Anthropic's profile of the account a Claude sign-in token belongs to, as the CLI itself reads it. */
export const CLAUDE_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";

const ClaudeTokenFile = z.looseObject({
  claudeAiOauth: z.looseObject({ accessToken: z.string().min(1) }),
});

const ClaudeProfile = z.looseObject({
  account: z.looseObject({ uuid: z.string().min(1), email: z.string().optional() }),
  organization: z.looseObject({ name: z.string().optional() }).nullish(),
});

/**
 * Who the sign-in belongs to, asked of Anthropic with the sign-in's own token, so the answer follows the token and
 * not a file an agent could write. `auth status` is no answer: it reports the email from `.claude.json`, which a
 * swapped `.credentials.json` does not change. Nor is the profile the CLI writes at a session's start: it fetches
 * one only when its copy is old, so after a refresh it often writes none. Spends no model tokens.
 */
async function readClaudeIdentity(ctx: UsageContext): Promise<AccountIdentity> {
  let token: string;
  try {
    const file = await readFile(join(ctx.account.home, ".credentials.json"), "utf8");
    token = ClaudeTokenFile.parse(JSON.parse(file)).claudeAiOauth.accessToken;
  } catch {
    throw new Error("This sign-in has no Claude token majhi can read");
  }
  const get = ctx.options.claudeProfile?.fetch ?? fetch;
  let res: Response;
  try {
    res = await get(ctx.options.claudeProfile?.url ?? CLAUDE_PROFILE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": CLAUDE_OAUTH_BETA },
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch {
    throw new Error("Could not reach Anthropic to read who this sign-in belongs to");
  }
  if (res.status === 401 || res.status === 403) throw new Error("Anthropic refused this sign-in's token");
  if (!res.ok) throw new Error(`Anthropic answered ${res.status} when asked who this sign-in belongs to`);
  const profile = ClaudeProfile.safeParse(await res.json().catch(() => undefined));
  if (!profile.success) throw new Error("Anthropic described this sign-in in a shape majhi does not know");
  const { account, organization } = profile.data;
  const label = [account.email, organization?.name ?? undefined].filter((p) => p !== undefined).join(", ");
  return { id: account.uuid, label: label === "" ? account.uuid : label };
}

/**
 * Claude Code compacts when a turn reaches its window minus a reserve of up to 20k tokens for the
 * reply and 13k of margin (checked in 2.1.284). `CLAUDE_CODE_AUTO_COMPACT_WINDOW` sets that window,
 * so the window that makes it compact at `compact_at` of the cap is the threshold plus the reserve.
 */
const CLAUDE_RESERVE = 33_000;
/** Claude Code raises a smaller window to this one. */
export const CLAUDE_MIN_WINDOW = 100_000;

export function claudeCapEnv({ tokens, compactAt }: ContextCap): Record<string, string> {
  const window = Math.round(tokens * compactAt) + CLAUDE_RESERVE;
  return { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(Math.min(tokens, Math.max(CLAUDE_MIN_WINDOW, window))) };
}

/**
 * What Claude Code prints when the account is out. Login: "Claude AI usage limit reached|<epoch>",
 * "Claude usage limit reached. Your limit will reset at 3pm (America/New_York)", "5-hour limit
 * reached ∙ resets 3pm", "You've hit your limit · resets 3pm (Europe/Berlin)", and the weekly and
 * Opus weekly forms of these. API key: rate_limit_error and 429, "would exceed the rate limit",
 * "Credit balance is too low".
 */
export const CLAUDE_LIMIT_SHAPES: LimitShapes = {
  error: [
    /\blimit reached\b/i,
    /\byou[\u2019']?ve hit your (?:[\w-]+ )*limit\b/i,
    /\brate_limit_error\b/i,
    /\b429\b/,
    /\btoo many requests\b/i,
    /\bwould exceed the rate limit\b/i,
    /\bcredit balance is too low\b/i,
  ],
  line: [
    /^(?:api error:\s*)?(?:(?:claude(?: ai)?|usage|5-hour|five-hour|session|weekly|7-day|opus|sonnet) ){0,3}limit reached\b/i,
    /^claude(?: ai)? usage limit reached\b/i,
    /^you[\u2019']?ve hit your (?:[\w-]+ )*limit(?:\s*[\u00b7\u2219.|,\u2014-]|\s*$)/i,
    /^api error:\s*429\b/i,
    /^api error:.*\b(?:rate_limit_error|credit balance is too low)\b/i,
    /^credit balance is too low\b/i,
  ],
};

export const claude: ToolDef = {
  capEnv: claudeCapEnv,
  limitShapes: CLAUDE_LIMIT_SHAPES,
  info: {
    id: "claude",
    name: "Claude Code",
    authModes: ["login", "api-key"],
    loginHint: "Open the link, sign in to Claude, then paste the code back here.",
    apiKeyLabel: "Anthropic API key",
    midTurnCapMin: CLAUDE_MIN_WINDOW,
  },
  configHomeVar: "CLAUDE_CONFIG_DIR",
  signInFile: ".credentials.json",
  apiKeyVar: "ANTHROPIC_API_KEY",
  adapter: { command: "claude-agent-acp", args: [] },
  // claude-agent-acp resets its tally when a turn starts (checked in 0.84.0).
  turnUsage: "turn",
  // Checked on claude-agent-acp 0.84.0: the SDK starts `claude --mcp-config <json>`, which expands ${VAR} in headers and variables.
  mcpOnArgv: true,
  // The owner's claude.ai connectors (Drive, Docs...) and synced plugins' MCP servers would
  // otherwise reach every agent, in every org. majhi attaches the tools an agent may use.
  runEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "1" },
  versionArgs: ["--cli", "--version"],
  authStatusArgs: ["--cli", "auth", "status", "--json"],
  loginArgs: ["--cli", "auth", "login", "--claudeai"],
  readUsage: readClaudeUsage,
  readIdentity: readClaudeIdentity,
  signInExpiresAt: claudeSignInExpiresAt,
  parseAuthStatus(exitCode, stdout) {
    if (exitCode !== 0) return { signedIn: false };
    try {
      const parsed = AuthStatusJson.safeParse(JSON.parse(stdout));
      if (parsed.success) {
        if (parsed.data.loggedIn === false) return { signedIn: false };
        const as = parsed.data.email ?? parsed.data.orgName;
        return as ? { signedIn: true, as } : { signedIn: true };
      }
    } catch {
      // Exit 0 already says signed in; the JSON only adds the email.
    }
    return { signedIn: true };
  },
};
