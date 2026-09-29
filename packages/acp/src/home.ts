import type { AccountRuntime } from "./index.ts";

/**
 * Creates the account's config home (mode 700) and any tool-specific files it
 * needs before login or a run. Idempotent. Called on account create and
 * before every login, probe and run.
 */
export function prepareHome(_account: AccountRuntime): Promise<void> {
  throw new Error("not implemented");
}
