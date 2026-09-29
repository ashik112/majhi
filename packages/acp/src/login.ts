import type { AccountRuntime, LoginSpec, RuntimeOptions } from "./index.ts";

/** The tool's own login command for a login account, run in the embedded terminal against the account home. */
export function loginCommand(_account: AccountRuntime, _options: RuntimeOptions): LoginSpec {
  throw new Error("not implemented");
}
