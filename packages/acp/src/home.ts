import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existingSignIn } from "./agent-home.ts";
import type { AccountRuntime, RuntimeOptions } from "./index.ts";
import { seedHome } from "./seed.ts";

const CODEX_STORE_LINE = 'cli_auth_credentials_store = "ephemeral"';

/**
 * Creates the config home (mode 700) and any tool-specific files it needs before login or a run.
 * Idempotent. Called on account create and before every login, probe and run.
 *
 * A session's home (`account.accountHome` set) is also seeded from the account's folder, once (seed.ts), and
 * gets a place for the account's sign-in file: a runner mounts the file there (an empty file is made so the
 * host does not create it as root), next to majhi (`options` given without a `spawner`) it is a link to the file.
 */
export async function prepareHome(
  account: AccountRuntime,
  options?: Pick<RuntimeOptions, "spawner">,
): Promise<void> {
  await mkdir(account.home, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone.
  await chmod(account.home, 0o700);

  if (account.accountHome !== undefined) {
    await seedHome(account);
    await shareSignIn(account, options !== undefined && options.spawner === undefined);
  }
  if (account.tool === "codex" && account.apiKey) {
    await keepCodexKeyOutOfAuthJson(account.home);
  }
}

/**
 * The home's place for the sign-in file, only when the account has one. `link`: next to majhi nothing can be
 * mounted, so the file is a link, and a CLI that rewrites it in place writes through it.
 */
async function shareSignIn(account: AccountRuntime, link: boolean): Promise<void> {
  const file = existingSignIn(account);
  if (file === undefined) return;
  const place = join(account.home, file.name);
  const current = await lstat(place).catch(() => undefined);
  if (link) {
    if (current?.isSymbolicLink() && (await readlink(place)) === file.source) return;
    // An empty file is only a place-holder made for a runner; a file with a sign-in in it is the CLI's own.
    if (current !== undefined && !current.isSymbolicLink() && current.size > 0) return;
    if (current !== undefined) await rm(place, { force: true });
    await symlink(file.source, place);
    return;
  }
  if (current === undefined) await writeFile(place, "", { mode: 0o600 });
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
