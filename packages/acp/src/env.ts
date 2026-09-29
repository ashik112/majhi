import type { AccountRuntime, BaseEnv } from "./index.ts";

export interface GitIdentity {
  name: string;
  email: string;
}

/**
 * Builds a spawned agent's environment from scratch (SPEC 5.1): the base
 * values, HOME and the tool's config home set to the account home, the API
 * key variable for API-key accounts, and the org's git identity.
 */
export function buildEnv(_account: AccountRuntime, _base: BaseEnv, _git?: GitIdentity): Record<string, string> {
  throw new Error("not implemented");
}
