import { z } from "zod";

/**
 * Why a backup was taken: `daily` is the automatic one, `manual` one the owner asked for,
 * `before-update` and `before-migration` the safety copies majhi takes before it changes itself,
 * and `before-restore` what a restore replaced.
 */
export const BackupKindSchema = z.enum([
  "daily",
  "manual",
  "before-update",
  "before-migration",
  "before-restore",
]);
export type BackupKind = z.infer<typeof BackupKindSchema>;

/** Newest daily backups kept, and the newest of each older week kept on top of them. */
export const BACKUP_KEEP_DAILY = 7;
export const BACKUP_KEEP_WEEKLY = 4;
/** Safety copies (manual, before an update, a migration or a restore) kept per kind. */
export const BACKUP_KEEP_SAFETY = 3;

export const BackupVerifySchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  /** What was checked, or what failed, in plain words. */
  detail: z.string(),
});
export type BackupVerify = z.infer<typeof BackupVerifySchema>;

export const BackupInfoSchema = z.object({
  /** The file name inside the backup folder; also what `backup.restore` takes. */
  name: z.string(),
  kind: BackupKindSchema,
  /** When the backup was taken. */
  at: z.string(),
  bytes: z.number().int().nonnegative(),
  /** `key` opens with the secrets key; `passphrase` needs the passphrase typed when it was made. */
  lock: z.enum(["key", "passphrase", "none"]),
  /** An older plain copy of majhi.db alone, from before full backups. */
  legacy: z.boolean(),
  /** The newest check of this backup, when one ran. */
  verified: BackupVerifySchema.optional(),
});
export type BackupInfo = z.infer<typeof BackupInfoSchema>;

export const BackupDestinationSchema = z.object({
  /** The folder the backups go to. */
  path: z.string(),
  /** False for the default folder inside the majhi home. */
  custom: z.boolean(),
  /** Why majhi cannot write there right now. */
  error: z.string().optional(),
});
export type BackupDestination = z.infer<typeof BackupDestinationSchema>;

export const BackupListSchema = z.object({
  /** How many of each kind are kept. */
  keep: z.object({ daily: z.number().int(), weekly: z.number().int(), safety: z.number().int() }),
  /** Newest first. */
  backups: z.array(BackupInfoSchema),
  /** When the newest backup of any kind was taken. */
  lastAt: z.string().optional(),
  /** When the newest daily backup was taken. */
  lastDaily: z.string().optional(),
  /** When the next daily one is due. */
  nextAt: z.string().optional(),
  destination: BackupDestinationSchema,
  /** The newest weekly or on-demand check. */
  lastVerify: BackupVerifySchema.extend({ name: z.string() }).optional(),
  /** Why the last backup failed, until one succeeds. */
  lastError: z.object({ at: z.string(), detail: z.string() }).optional(),
  /** Set when a restore is staged and majhi is about to restart onto it. */
  pending: z.string().optional(),
  /** What the last restore did when majhi started on it. */
  restored: z.object({ at: z.string(), ok: z.boolean(), detail: z.string() }).optional(),
  /** Something runs now: `backup`, `verify` or `restore`. */
  busy: z.enum(["backup", "verify", "restore"]).optional(),
});
export type BackupList = z.infer<typeof BackupListSchema>;

/** Longest passphrase majhi takes for a backup. */
export const BACKUP_PASSPHRASE_MAX = 256;
