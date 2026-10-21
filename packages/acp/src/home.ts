import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existingSignIn } from "./agent-home.ts";
import type { AccountRuntime } from "./index.ts";
import { seedHome } from "./seed.ts";

const CODEX_STORE_LINE = 'cli_auth_credentials_store = "ephemeral"';

/**
 * Creates the config home (mode 700) and any tool-specific files it needs before login or a run.
 * Idempotent. Called on account create and before every login, probe and run.
 *
 * A session's home (`account.accountHome` set) is also seeded from the account's folder, once (seed.ts), and
 * gets a place for the account's sign-in file: the runner mounts the file there (an empty file is made so the
 * host does not create it as root).
 */
export async function prepareHome(account: AccountRuntime): Promise<void> {
  await mkdir(account.home, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  await chmod(account.home, 0o700);

  if (account.accountHome !== undefined) {
    await seedHome(account);
    await shareSignIn(account);
  }
  if (account.tool === "codex" && account.apiKey) {
    await keepCodexKeyOutOfAuthJson(account.home);
  }
}

/** The home's place for the sign-in file, only when the account has one: an empty file the runner mounts over. */
async function shareSignIn(account: AccountRuntime): Promise<void> {
  const file = existingSignIn(account);
  if (file === undefined) return;
  const place = join(account.home, file.name);
  if ((await lstat(place).catch(() => undefined)) === undefined) await writeFile(place, "", { mode: 0o600 });
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
