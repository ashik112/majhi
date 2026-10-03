import type { AccountUsage, ModelUsageWindow } from "@majhi/shared";
import { z } from "zod";
import { SignInExpired } from "../auth-failure.ts";
import { exec } from "../exec.ts";
import { CLAUDE_USAGE_SCRIPT } from "./claude-usage-helper.ts";
import type { ContextCap, ToolDef, UsageContext } from "./types.ts";

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
    command: process.execPath,
    args: [
      "--input-type=module",
      "-e",
      CLAUDE_USAGE_SCRIPT,
      ctx.adapter.command,
      String(Math.max(1000, ctx.timeoutMs - 2000)),
    ],
  };
  const res = await exec(helper.command, helper.args, ctx.env, ctx.timeoutMs);
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

export const claude: ToolDef = {
  capEnv: claudeCapEnv,
  info: {
    id: "claude",
    name: "Claude Code",
    authModes: ["login", "api-key"],
    loginHint: "Open the link, sign in to Claude, then paste the code back here.",
    apiKeyLabel: "Anthropic API key",
    midTurnCapMin: CLAUDE_MIN_WINDOW,
  },
  configHomeVar: "CLAUDE_CONFIG_DIR",
  apiKeyVar: "ANTHROPIC_API_KEY",
  adapter: { command: "claude-agent-acp", args: [] },
  // claude-agent-acp resets its tally when a turn starts (checked in 0.84.0).
  turnUsage: "turn",
  // The owner's claude.ai connectors (Drive, Docs...) and synced plugins' MCP servers would
  // otherwise reach every agent, in every org. majhi attaches the tools an agent may use.
  runEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS: "1" },
  versionArgs: ["--cli", "--version"],
  authStatusArgs: ["--cli", "auth", "status", "--json"],
  loginArgs: ["--cli", "auth", "login", "--claudeai"],
  readUsage: readClaudeUsage,
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
