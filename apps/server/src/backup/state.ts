import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BackupVerifySchema } from "@majhi/shared";
import { z } from "zod";

export const BACKUP_DIR = "backups";
const SETTINGS_FILE = "backup-settings.json";
const STATE_FILE = "backup-state.json";

/** Where backups go. Absent means the default folder inside the majhi home. */
const SettingsSchema = z.object({ destination: z.string().optional() });
export type BackupSettings = z.infer<typeof SettingsSchema>;

/**
 * What majhi remembers about its backups, locally: the newest check of each archive (the archive
 * folder may be a synced one that majhi should not write bookkeeping into) and the last failure.
 */
const StateSchema = z.object({
  verifies: z.record(z.string(), BackupVerifySchema.extend({ damaged: z.boolean().default(false) })).default({}),
  lastVerify: BackupVerifySchema.extend({ name: z.string() }).optional(),
  lastError: z.object({ at: z.string(), detail: z.string() }).optional(),
});
export type BackupState = z.infer<typeof StateSchema>;

export function defaultDir(home: string): string {
  return join(home, BACKUP_DIR);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(join(file, ".."), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readSettings(home: string): Promise<BackupSettings> {
  const parsed = SettingsSchema.safeParse(await readJson(join(home, SETTINGS_FILE)));
  return parsed.success ? parsed.data : {};
}

export function writeSettings(home: string, settings: BackupSettings): Promise<void> {
  return writeJson(join(home, SETTINGS_FILE), settings);
}

export async function readState(home: string): Promise<BackupState> {
  const parsed = StateSchema.safeParse(await readJson(join(home, STATE_FILE)));
  return parsed.success ? parsed.data : { verifies: {} };
}

export function writeState(home: string, state: BackupState): Promise<void> {
  return writeJson(join(home, STATE_FILE), state);
}

/** The folder backups go to now. */
export async function destinationOf(home: string): Promise<{ path: string; custom: boolean }> {
  const { destination } = await readSettings(home);
  return destination === undefined ? { path: defaultDir(home), custom: false } : { path: destination, custom: true };
}
