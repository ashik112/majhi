import { z } from "zod";

/**
 * The host helper (`apps/host`) runs natively on the owner's machine and does
 * what the container cannot: browse host folders and remount workspace roots.
 * It opens no port. It long-polls the server for jobs and posts replies back:
 *
 *   POST /api/host/poll   -> 200 HostJob, or 204 when no job arrived in time
 *   POST /api/host/reply  <- HostReply
 *
 * Both require `Authorization: Bearer <token>`, where the token is the content
 * of `<MAJHI_HOME>/host.token` (created by the helper, mode 600, git-ignored).
 */
export const HOST_TOKEN_FILE = "host.token";
export const HOST_POLL_TIMEOUT_MS = 25_000;

export const DirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** True when the folder has a `.git` directory. */
  isRepo: z.boolean(),
  hidden: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const DirListingSchema = z.object({
  path: z.string(),
  /** Null at the filesystem root. */
  parent: z.string().nullable(),
  home: z.string(),
  entries: z.array(DirEntrySchema),
  /** True when the folder had more subfolders than the helper returns. */
  truncated: z.boolean(),
});
export type DirListing = z.infer<typeof DirListingSchema>;

export const RootSuggestionSchema = z.object({
  path: z.string(),
  repoCount: z.number().int().nonnegative(),
});
export type RootSuggestion = z.infer<typeof RootSuggestionSchema>;

export const HostJobSchema = z.discriminatedUnion("method", [
  z.object({
    id: z.string(),
    method: z.literal("listDirs"),
    params: z.object({ path: z.string(), showHidden: z.boolean() }),
  }),
  z.object({ id: z.string(), method: z.literal("suggestRoots"), params: z.object({}) }),
  /** Regenerate the compose override from majhi.yaml and recreate the server container. */
  z.object({ id: z.string(), method: z.literal("remount"), params: z.object({}) }),
]);
export type HostJob = z.infer<typeof HostJobSchema>;
export type HostMethod = HostJob["method"];

export const HostResultSchemas = {
  listDirs: DirListingSchema,
  suggestRoots: z.object({ suggestions: z.array(RootSuggestionSchema) }),
  /** The helper answers before it restarts the server, so the server can tell the UI. */
  remount: z.object({ accepted: z.literal(true) }),
} as const satisfies Record<HostMethod, z.ZodType>;

export const HostReplySchema = z.discriminatedUnion("ok", [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: z.string() }),
]);
export type HostReply = z.infer<typeof HostReplySchema>;

/** Sent by the helper in the `x-majhi-host` header on every poll. */
export const HostInfoSchema = z.object({
  version: z.string(),
  platform: z.string(),
  /** False when the helper cannot run Docker commands, so remounting is manual. */
  canRemount: z.boolean(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;
export const HOST_INFO_HEADER = "x-majhi-host";

export const HostStatusSchema = z.object({
  connected: z.boolean(),
  info: HostInfoSchema.optional(),
  lastSeen: z.string().optional(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;
