import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigHistory } from "../config/history.ts";
import type { ServerEnv } from "../env.ts";
import { errorMessage } from "../errors.ts";
import { MEMORY_MIGRATIONS } from "../memory/migrations.ts";
import { SecretStore } from "../secrets/store.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { newestMigration } from "./archive.ts";
import { BackupService, fileSources } from "./service.ts";
import { applyPendingRestore } from "./swap.ts";

/** True when a database file is behind this build, so opening it will migrate it. */
function behind(file: string, migrations: readonly { id: number }[]): boolean {
  if (!existsSync(file)) return false;
  const have = newestMigration(file);
  return have !== null && have < Math.max(...migrations.map((m) => m.id));
}

/**
 * What happens before majhi opens a single file. A restore staged earlier is swapped in (or undone
 * if it cannot be), and when a database is about to be migrated by this build, a backup is taken
 * first. Neither failure stops majhi from starting: the swap undoes itself, and a missing safety
 * copy is logged.
 */
export async function prepareStart(env: ServerEnv): Promise<void> {
  try {
    applyPendingRestore(env.majhiHome);
  } catch (err) {
    console.error(`majhi could not apply the staged restore: ${errorMessage(err)}`);
  }
  const home = env.majhiHome;
  if (!behind(join(home, "majhi.db"), MIGRATIONS) && !behind(join(home, "memory", "memory.db"), MEMORY_MIGRATIONS)) {
    return;
  }
  const secrets = new SecretStore(home, env.secretsKeyFile);
  const backup = new BackupService({
    majhiHome: home,
    databases: () => fileSources(home).filter((d) => existsSync(join(home, d.rel))),
    history: new ConfigHistory(home),
    key: () => secrets.identityForBackups(),
    version: { version: env.version, commit: env.commit },
  });
  try {
    const name = await backup.before("before-migration");
    if (name !== undefined) console.log(`majhi backed up its data before updating its database (${name})`);
  } catch (err) {
    console.error(`majhi could not back up before updating its database: ${errorMessage(err)}`);
  }
}
