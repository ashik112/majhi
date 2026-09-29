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

/** Command that runs the fake ACP adapter for `tool`, for `RuntimeOptions.adapters`. */
export function fakeAdapter(_tool: ToolId, _options?: FakeAgentOptions): Command {
  throw new Error("not implemented");
}
