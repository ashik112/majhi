/**
 * Fake ACP adapter for tests. Run with `node fake-agent.ts --tool claude [flags] [tool argv]`.
 * Flags come first, then the tool's own argv (`--cli auth status --json`, `cli login status`).
 * No tool argv means: speak ACP over stdio. Never touches the network or real credentials.
 * Only erasable TypeScript here, so Node runs it without a build step.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { serveAcp } from "./fake-turn.ts";

const Flags = z.object({
  tool: z.enum(["claude", "codex"]),
  signedIn: z.boolean(),
  broken: z.boolean(),
  models: z.array(z.string().min(1)),
  efforts: z.array(z.string().min(1)),
  /** Delay in ms between the steps of a scripted turn. */
  slowMs: z.number().int().nonnegative(),
  /** Advertise `loadSession`. */
  loadSession: z.boolean(),
  /** Advertise image prompts. */
  images: z.boolean(),
  /** Tokens each turn adds to the reported usage (0: fixed readings). */
  risingUsage: z.number().int().nonnegative(),
  /** `/compact` does not lower usage. */
  compactNoop: z.boolean(),
  /** Tokens per prompt as input,output,thought,cacheRead,cacheWrite; `none` reports none. */
  turnTokens: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      thought: z.number().int().nonnegative(),
      cacheRead: z.number().int().nonnegative(),
      cacheWrite: z.number().int().nonnegative(),
    })
    .optional(),
  /** Dollars per prompt in the running cost; absent reports no cost. */
  turnCost: z.number().nonnegative().optional(),
  usageModel: z.string().min(1).optional(),
  /** Canned usage for the Claude `usage` argv and the Codex app-server. */
  usage: z.object({
    fiveHourPct: z.number(),
    weekPct: z.number(),
    opusPct: z.number().optional(),
    fiveHourResetsAt: z.string().optional(),
    weekResetsAt: z.string().optional(),
    plan: z.string(),
  }),
});
type Flags = z.infer<typeof Flags>;

function parseFlags(argv: string[]): { flags: Flags; rest: string[] } {
  const raw: {
    tool?: string | undefined;
    signedIn: boolean;
    broken: boolean;
    models: string[];
    efforts: string[];
    slowMs: number;
    loadSession: boolean;
    images: boolean;
    risingUsage: number;
    compactNoop: boolean;
    turnTokens?: { input: number; output: number; thought: number; cacheRead: number; cacheWrite: number };
    turnCost?: number;
    usageModel?: string;
    usage: {
      fiveHourPct: number;
      weekPct: number;
      opusPct?: number;
      fiveHourResetsAt?: string;
      weekResetsAt?: string;
      plan: string;
    };
  } = {
    signedIn: false,
    broken: false,
    models: ["fake-model-a", "fake-model-b"],
    efforts: ["low", "medium", "high"],
    slowMs: 0,
    loadSession: true,
    images: true,
    risingUsage: 0,
    compactNoop: false,
    usage: { fiveHourPct: 42, weekPct: 18, plan: "max" },
  };
  // Unless a flag says otherwise, every prompt reports tokens, and the Claude fake a running cost.
  let tokensSet = false;
  let costSet = false;
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tool") raw.tool = argv[++i];
    else if (a === "--signed-in") raw.signedIn = true;
    else if (a === "--broken") raw.broken = true;
    else if (a === "--models") raw.models = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--efforts") raw.efforts = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--slow") raw.slowMs = Number(argv[++i]);
    else if (a === "--no-load-session") raw.loadSession = false;
    else if (a === "--no-images") raw.images = false;
    else if (a === "--rising-usage") raw.risingUsage = Number(argv[++i]);
    else if (a === "--compact-noop") raw.compactNoop = true;
    else if (a === "--turn-tokens") {
      tokensSet = true;
      const v = argv[++i] ?? "";
      if (v === "none") delete raw.turnTokens;
      else {
        const [input = 0, output = 0, thought = 0, cacheRead = 0, cacheWrite = 0] = v.split(",").map(Number);
        raw.turnTokens = { input, output, thought, cacheRead, cacheWrite };
      }
    } else if (a === "--turn-cost") {
      costSet = true;
      const v = argv[++i] ?? "";
      if (v === "none") delete raw.turnCost;
      else raw.turnCost = Number(v);
    } else if (a === "--usage-model") raw.usageModel = argv[++i] ?? "";
    else if (a === "--five-hour-pct") raw.usage.fiveHourPct = Number(argv[++i]);
    else if (a === "--week-pct") raw.usage.weekPct = Number(argv[++i]);
    else if (a === "--opus-pct") raw.usage.opusPct = Number(argv[++i]);
    else if (a === "--five-hour-resets-at") raw.usage.fiveHourResetsAt = argv[++i] ?? "";
    else if (a === "--week-resets-at") raw.usage.weekResetsAt = argv[++i] ?? "";
    else if (a === "--plan") raw.usage.plan = argv[++i] ?? "";
    else break;
  }
  if (!tokensSet) {
    raw.turnTokens =
      raw.tool === "codex"
        ? { input: 1_000, output: 200, thought: 50, cacheRead: 4_000, cacheWrite: 0 }
        : { input: 1_000, output: 200, thought: 0, cacheRead: 4_000, cacheWrite: 500 };
  }
  if (!costSet && raw.tool === "claude") raw.turnCost = 0.0125;
  return { flags: Flags.parse(raw), rest: argv.slice(i) };
}

const CLAUDE_VERSION = "2.1.284 (Claude Code)";
const CODEX_VERSION = "codex-cli 0.158.0";

function homeFor(flags: Flags): string {
  const v = flags.tool === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
  if (!v) throw new Error("config home is not set");
  return v;
}

function credentialFile(flags: Flags): string {
  return join(homeFor(flags), flags.tool === "claude" ? ".credentials.json" : "auth.json");
}

function isSignedIn(flags: Flags): boolean {
  if (flags.signedIn) return true;
  const key = flags.tool === "claude" ? process.env.ANTHROPIC_API_KEY : process.env.CODEX_API_KEY;
  if (key) return true;
  return existsSync(credentialFile(flags));
}

function readLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin });
  return new Promise((resolve) => {
    rl.once("line", (line) => {
      resolve(line);
      rl.close();
    });
    rl.once("close", () => resolve(""));
  });
}

async function writeCredentials(flags: Flags): Promise<void> {
  await mkdir(homeFor(flags), { recursive: true, mode: 0o700 });
  const body =
    flags.tool === "claude"
      ? { claudeAiOauth: { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: 0 } }
      : { tokens: { access_token: "fake-access", refresh_token: "fake-refresh" } };
  await writeFile(credentialFile(flags), JSON.stringify(body), { mode: 0o600 });
}

const HOUR_MS = 3_600_000;

/** Reset times: the flags, or fixed offsets from now (3 hours and 3 days). */
function resets(flags: Flags): { fiveHour: string; week: string } {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  return {
    fiveHour: flags.usage.fiveHourResetsAt ?? at(3 * HOUR_MS),
    week: flags.usage.weekResetsAt ?? at(72 * HOUR_MS),
  };
}

/** What the Claude usage helper prints, in the shape of the SDK's usage response. */
function claudeUsageJson(flags: Flags): string {
  const r = resets(flags);
  const { usage } = flags;
  return JSON.stringify({
    subscription_type: usage.plan,
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: usage.fiveHourPct, resets_at: r.fiveHour },
      seven_day: { utilization: usage.weekPct, resets_at: r.week },
      seven_day_opus: null,
      seven_day_sonnet: null,
      model_scoped:
        usage.opusPct === undefined
          ? []
          : [{ display_name: "Opus", utilization: usage.opusPct, resets_at: r.week }],
    },
  });
}

/** Just enough of `codex app-server`: initialize, initialized, account/rateLimits/read. */
async function serveCodexAppServer(flags: Flags): Promise<number> {
  const rl = createInterface({ input: process.stdin });
  const reply = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const line of rl) {
    const msg = z
      .object({ id: z.number().optional(), method: z.string() })
      .safeParse(JSON.parse(line) as unknown);
    if (!msg.success) continue;
    const { id, method } = msg.data;
    if (method === "initialize") {
      reply({
        id,
        result: { userAgent: "fake", codexHome: homeFor(flags), platformFamily: "unix", platformOs: "linux" },
      });
    } else if (method === "account/rateLimits/read") {
      if (!isSignedIn(flags)) {
        reply({
          id,
          error: { code: -32600, message: "codex account authentication required to read rate limits" },
        });
        continue;
      }
      const r = resets(flags);
      const seconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
      reply({
        id,
        result: {
          rateLimits: {
            primary: {
              usedPercent: flags.usage.fiveHourPct,
              windowDurationMins: 300,
              resetsAt: seconds(r.fiveHour),
            },
            secondary: {
              usedPercent: flags.usage.weekPct,
              windowDurationMins: 10080,
              resetsAt: seconds(r.week),
            },
            planType: flags.usage.plan,
            credits: null,
          },
        },
      });
    }
  }
  return 0;
}

async function runCli(flags: Flags, argv: string[]): Promise<number> {
  const line = argv.join(" ");
  if (flags.tool === "claude") {
    if (line === "--cli --version") {
      console.log(CLAUDE_VERSION);
      return 0;
    }
    if (line === "--cli auth status --json") {
      const signedIn = isSignedIn(flags);
      console.log(
        JSON.stringify(
          signedIn
            ? { loggedIn: true, email: "fake@example.com", orgName: "Fake Org", subscriptionType: "max" }
            : { loggedIn: false },
        ),
      );
      return signedIn ? 0 : 1;
    }
    if (line === "usage") {
      if (!isSignedIn(flags)) {
        console.error("Not signed in");
        return 1;
      }
      process.stdout.write(claudeUsageJson(flags));
      return 0;
    }
    if (line === "--cli auth login --claudeai") {
      console.log("Opening browser to sign in: https://claude.ai/oauth/authorize?fake=1");
      process.stdout.write("Paste code here if prompted > ");
      const code = (await readLine()).trim();
      if (!code) {
        console.error("\nLogin failed: no code");
        return 1;
      }
      await writeCredentials(flags);
      console.log("\nLogin successful.");
      return 0;
    }
  } else {
    if (line === "cli --version") {
      console.log(CODEX_VERSION);
      return 0;
    }
    if (line === "cli app-server") return serveCodexAppServer(flags);
    if (line === "cli login status") {
      const signedIn = isSignedIn(flags);
      console.log(signedIn ? "Logged in using ChatGPT" : "Not logged in");
      return signedIn ? 0 : 1;
    }
    if (line === "cli login --device-auth") {
      console.log("Open https://auth.openai.com/codex/device and enter the code FAKE-1234");
      console.log("Press Enter once you have finished in the browser");
      await readLine();
      await writeCredentials(flags);
      console.log("Successfully logged in");
      return 0;
    }
  }
  console.error(`fake-agent: unknown command: ${line}`);
  return 2;
}

function serve(flags: Flags): void {
  serveAcp({
    tool: flags.tool,
    models: flags.models,
    efforts: flags.efforts,
    slowMs: flags.slowMs,
    loadSession: flags.loadSession,
    images: flags.images,
    risingUsage: flags.risingUsage,
    compactNoop: flags.compactNoop,
    turnTokens: flags.turnTokens,
    turnCost: flags.turnCost,
    usageModel: flags.usageModel,
    signedIn: () => isSignedIn(flags),
  });
}

async function main(): Promise<void> {
  const { flags, rest } = parseFlags(process.argv.slice(2));
  if (flags.broken) {
    console.error("fake-agent: broken on purpose");
    process.exit(1);
  }
  if (rest.length > 0) {
    process.exit(await runCli(flags, rest));
  }
  serve(flags);
}

await main();
