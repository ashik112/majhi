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

/**
 * What the helper knows about SSH keys in the Mac's agent. majhi's own git
 * (fetch now, push later) uses that agent through the forwarded socket.
 */
export const SshStatusSchema = z.object({
  /** Keys the agent holds after the last check. */
  loaded: z.number().int().nonnegative(),
  /** Private key files, with `~`, that have a passphrase the Keychain does not hold yet. */
  needsPassphrase: z.array(z.string()),
  error: z.string().optional(),
  checkedAt: z.string(),
});
export type SshStatus = z.infer<typeof SshStatusSchema>;

/** Longest passphrase majhi accepts. It goes to the helper once and is never stored. */
export const SSH_PASSPHRASE_MAX = 1024;

/** The one-time command that gives a passphrase-protected key to the macOS Keychain. */
export function sshUnlockCommand(key: string): string {
  return `ssh-add --apple-use-keychain ${key}`;
}

export const HostJobSchema = z.discriminatedUnion("method", [
  z.object({
    id: z.string(),
    method: z.literal("listDirs"),
    params: z.object({ path: z.string(), showHidden: z.boolean() }),
  }),
  z.object({ id: z.string(), method: z.literal("suggestRoots"), params: z.object({}) }),
  /** Regenerate the compose override from majhi.yaml and recreate the server container. */
  z.object({ id: z.string(), method: z.literal("remount"), params: z.object({}) }),
  /** Load the Mac's SSH keys into its agent again and report the result. */
  z.object({ id: z.string(), method: z.literal("ssh.reload"), params: z.object({}) }),
  /**
   * Give a key its passphrase once so the macOS Keychain keeps it. `passphrase`
   * must never be logged, stored or echoed in an error, on either side.
   */
  z.object({
    id: z.string(),
    method: z.literal("ssh.unlock"),
    params: z.object({ key: z.string().min(1), passphrase: z.string().min(1).max(SSH_PASSPHRASE_MAX) }),
  }),
]);
export type HostJob = z.infer<typeof HostJobSchema>;
export type HostMethod = HostJob["method"];

export const HostResultSchemas = {
  listDirs: DirListingSchema,
  suggestRoots: z.object({ suggestions: z.array(RootSuggestionSchema) }),
  /** The helper answers before it restarts the server, so the server can tell the UI. */
  remount: z.object({ accepted: z.literal(true) }),
  "ssh.reload": SshStatusSchema,
  "ssh.unlock": SshStatusSchema,
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
  /** Absent until the helper's first key check ends, and from older helpers. */
  ssh: SshStatusSchema.optional(),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;
export const HOST_INFO_HEADER = "x-majhi-host";

/** What `ssh -T` said about one git host that a registered project's remote uses. */
export const SshHostCheckSchema = z.object({
  /** The alias or `user@host` the remote uses, like `gitlab-ashik112`. */
  host: z.string(),
  state: z.enum(["reachable", "auth-failed", "unreachable"]),
  /** A fixed sentence. Never ssh's own output. */
  detail: z.string(),
});
export type SshHostCheck = z.infer<typeof SshHostCheckSchema>;

export const HostStatusSchema = z.object({
  connected: z.boolean(),
  /** From majhi's own ssh probes, so it is there even when no helper is connected. Absent before the first probe ends. */
  sshHosts: z.array(SshHostCheckSchema).optional(),
  info: HostInfoSchema.optional(),
  lastSeen: z.string().optional(),
});
export type HostStatus = z.infer<typeof HostStatusSchema>;
