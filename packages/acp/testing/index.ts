import { fileURLToPath } from "node:url";
import type { ToolId } from "@majhi/shared";
import type { Command } from "../src/index.ts";

/** How the fake agent behaves. */
export interface FakeAgentOptions {
  /** Signed in from the start. Default false: `auth` fails until the fake login ran. */
  signedIn?: boolean;
  /** Models to offer over ACP. Default: two models, the first one default. */
  models?: string[];
  efforts?: string[];
  /** Fail to start (`cli` step fails). */
  broken?: boolean;
  /** Delay between the steps of the scripted turn, so cancel and interrupt can be tested. Default 0. */
  slowMs?: number;
  /** Do not advertise `loadSession`. */
  noLoadSession?: boolean;
  /** Do not advertise image prompts. */
  noImages?: boolean;
  /** Numbers the fake reports for usage. Defaults: 5h 42 %, week 18 %, plan "max", resets in 3 hours and 3 days. */
  usage?: {
    fiveHourPct?: number;
    weekPct?: number;
    /** Adds an "Opus" weekly window on Claude. */
    opusPct?: number;
    /** ISO time. */
    fiveHourResetsAt?: string;
    weekResetsAt?: string;
    plan?: string;
  };
}

const FAKE_AGENT = fileURLToPath(new URL("./fake-agent.ts", import.meta.url));

/**
 * Command that runs the fake ACP adapter for `tool`, for `RuntimeOptions.adapters`.
 * Options travel as flags because agent environments are built from scratch.
 */
export function fakeAdapter(tool: ToolId, options: FakeAgentOptions = {}): Command {
  const args = [FAKE_AGENT, "--tool", tool];
  if (options.signedIn) args.push("--signed-in");
  if (options.broken) args.push("--broken");
  if (options.models) args.push("--models", options.models.join(","));
  if (options.efforts) args.push("--efforts", options.efforts.join(","));
  if (options.slowMs) args.push("--slow", String(options.slowMs));
  if (options.noLoadSession) args.push("--no-load-session");
  if (options.noImages) args.push("--no-images");
  const u = options.usage;
  if (u?.fiveHourPct !== undefined) args.push("--five-hour-pct", String(u.fiveHourPct));
  if (u?.weekPct !== undefined) args.push("--week-pct", String(u.weekPct));
  if (u?.opusPct !== undefined) args.push("--opus-pct", String(u.opusPct));
  if (u?.fiveHourResetsAt) args.push("--five-hour-resets-at", u.fiveHourResetsAt);
  if (u?.weekResetsAt) args.push("--week-resets-at", u.weekResetsAt);
  if (u?.plan) args.push("--plan", u.plan);
  return { command: process.execPath, args };
}

/**
 * Command that prints the fake Claude usage, for `RuntimeOptions.usage.claude`.
 * Takes the same options as `fakeAdapter`.
 */
export function fakeUsage(options: FakeAgentOptions = {}): Command {
  const adapter = fakeAdapter("claude", options);
  return { command: adapter.command, args: [...adapter.args, "usage"] };
}
