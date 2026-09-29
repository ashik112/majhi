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
  return { command: process.execPath, args };
}
