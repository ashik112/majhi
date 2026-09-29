import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountRuntime } from "./index.ts";

const CODEX_STORE_LINE = 'cli_auth_credentials_store = "ephemeral"';

/**
 * Creates the account's config home (mode 700) and any tool-specific files it
 * needs before login or a run. Idempotent. Called on account create and
 * before every login, probe and run.
 */
export async function prepareHome(account: AccountRuntime): Promise<void> {
  await mkdir(account.home, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  await chmod(account.home, 0o700);

  if (account.tool === "codex" && account.apiKey) {
    await keepCodexKeyOutOfAuthJson(account.home);
  }
}

/**
 * Codex writes an API-key login into auth.json by default. The ephemeral
 * store keeps the key in memory so it stays only in secrets.age.
 * UNVERIFIED against a real key: docs/research/acp-auth.md marks this as an
 * inference. Recheck when a real Codex API-key account is first set up.
 */
async function keepCodexKeyOutOfAuthJson(home: string): Promise<void> {
  const file = join(home, "config.toml");
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const lines = existing.split("\n");
  const at = lines.findIndex((l) => /^\s*cli_auth_credentials_store\s*=/.test(l));
  if (at >= 0) {
    if (lines[at]?.trim() === CODEX_STORE_LINE) return;
    lines[at] = CODEX_STORE_LINE;
    await writeFile(file, lines.join("\n"), { mode: 0o600 });
    return;
  }
  // A top-level key must come before any [table].
  await writeFile(file, existing ? `${CODEX_STORE_LINE}\n${existing}` : `${CODEX_STORE_LINE}\n`, {
    mode: 0o600,
  });
}
