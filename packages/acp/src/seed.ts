import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AccountRuntime } from "./index.ts";

/**
 * What a new workspace home takes from the account's folder: only the fields below, never the rest. The
 * account folder's `.claude.json` also holds `mcpServers`, `projects`, hooks and settings, and an account
 * folder that agents wrote to before workspaces had homes may hold planted ones, so nothing is copied that is
 * not named here. `z.object` drops every key it does not name.
 *
 * - `oauthAccount`: who the account is (checked on Claude Code 2.1.284). `auth status` reports the email and
 *   organization from here, not from the token, and a session refreshes it from the token at its start.
 *   Seeded, a new home answers `auth status` at once and its first session does not start from nothing.
 * - `userID`: the anonymous id the CLI keeps in this file, so every workspace of an account looks like the
 *   same user to its feature flags and telemetry instead of a new install each.
 * - `hasCompletedOnboarding`: the CLI's first-run flag, so a new home does not show the first-run flow.
 * Sessions start and open without any of them (checked: only `.credentials.json` in an empty home), so a
 * missing or damaged source only means the CLI makes its own.
 */
const ClaudeSeed = z.object({
  oauthAccount: z
    .object({
      accountUuid: z.string().optional(),
      emailAddress: z.string().optional(),
      organizationUuid: z.string().optional(),
      organizationName: z.string().optional(),
      displayName: z.string().optional(),
      billingType: z.string().optional(),
      hasExtraUsageEnabled: z.boolean().optional(),
    })
    .optional(),
  userID: z.string().optional(),
  hasCompletedOnboarding: z.boolean().optional(),
});

const CLAUDE_CONFIG = ".claude.json";

/**
 * Gives a new workspace home what its CLI needs to start from the account's folder, once: a home that has its
 * CLI's own file already is left alone, since the CLI keeps it up to date from then on. Codex needs nothing
 * besides the sign-in file (shared on its own), so it seeds nothing. Never throws: a source that is missing or
 * does not parse seeds nothing.
 */
export async function seedHome(account: AccountRuntime): Promise<void> {
  if (account.accountHome === undefined || account.tool !== "claude") return;
  let source: unknown;
  try {
    source = JSON.parse(await readFile(join(account.accountHome, CLAUDE_CONFIG), "utf8"));
  } catch {
    return;
  }
  const seed = ClaudeSeed.safeParse(source);
  if (!seed.success || Object.keys(seed.data).length === 0) return;
  try {
    // `wx`: never over a file the CLI already made, even when two sessions start together.
    await writeFile(join(account.home, CLAUDE_CONFIG), JSON.stringify(seed.data), {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    // Already there (the normal case after the first start), or the home cannot be written: the CLI copes.
  }
}
