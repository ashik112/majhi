import { z } from "zod";

/** `daily` is the automatic snapshot, `manual` one the owner asked for, `before-restore` what a restore replaced. */
export const BackupKindSchema = z.enum(["daily", "manual", "before-restore"]);
export type BackupKind = z.infer<typeof BackupKindSchema>;

export const BackupInfoSchema = z.object({
  /** The file name inside `<majhi home>/backups`; also what `backup.restore` takes. */
  name: z.string(),
  kind: BackupKindSchema,
  /** When the snapshot was taken. */
  at: z.string(),
  bytes: z.number().int().nonnegative(),
});
export type BackupInfo = z.infer<typeof BackupInfoSchema>;

export const BackupListSchema = z.object({
  /** Snapshots kept of each kind. */
  keep: z.number().int(),
  /** Newest first. */
  backups: z.array(BackupInfoSchema),
  /** When the newest daily snapshot was taken. */
  lastDaily: z.string().optional(),
  /** Set when a restore is staged and waits for the next start. */
  pending: z.string().optional(),
});
export type BackupList = z.infer<typeof BackupListSchema>;
