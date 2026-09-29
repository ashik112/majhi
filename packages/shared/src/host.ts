import { z } from "zod";
import { LayaStatusSchema } from "./decisions.ts";

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

/** Which Docker runtime the helper found on the Mac. It names the one that asks for folder access. */
export const DockerRuntimeSchema = z.enum(["orbstack", "docker-desktop", "docker"]);
export type DockerRuntime = z.infer<typeof DockerRuntimeSchema>;

export function dockerRuntimeName(runtime: DockerRuntime | undefined): string {
  if (runtime === "orbstack") return "OrbStack";
  if (runtime === "docker-desktop") return "Docker Desktop";
  return "Docker";
}

/** A git commit as `git rev-parse` prints it, or a prefix of one. */
export const CommitSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

/**
 * How an update is going. The helper writes it to `<MAJHI_HOME>/update.json` because the server
 * that would relay it is replaced part-way through. The server reads the file back.
 */
export const UpdateStatusSchema = z.object({
  state: z.enum(["running", "done", "failed"]),
  /** The commit being built. */
  commit: z.string(),
  startedAt: z.string(),
  /** Plain progress lines, oldest first, at most 40. */
  lines: z.array(z.string()),
  /** Why it failed, in plain words. */
  error: z.string().optional(),
});
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;
export const UPDATE_STATUS_FILE = "update.json";

/** A question in Laya's own format, as the Python service takes it. The server maps ours onto it. */
export const LayaQuestionSchema = z.object({
  type: z.enum(["choice", "score", "noul"]),
  instructions: z.string(),
  /** Choice labels or score level descriptions. Omitted for noul. */
  criteria: z.union([z.array(z.string()), z.record(z.string(), z.string())]).optional(),
});
export type LayaQuestion = z.infer<typeof LayaQuestionSchema>;

/** One answer as laya-mlx returns it. `noul` is the probability that the statement is true. */
export const LayaAnswerSchema = z.object({
  type: z.enum(["choice", "score", "noul"]),
  confidence: z.number().min(0).max(1),
  choice: z.string().optional(),
  score: z.number().optional(),
  noul: z.number().min(0).max(1).optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
});
export type LayaAnswer = z.infer<typeof LayaAnswerSchema>;

export const LayaDecideResultSchema = z.object({
  answers: z.record(z.string(), LayaAnswerSchema),
  /** Time to load the model for this call, 0 when it was already loaded. */
  loadMs: z.number().nonnegative(),
  predictMs: z.number().nonnegative(),
});
export type LayaDecideResult = z.infer<typeof LayaDecideResultSchema>;

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
  /** The checkout's HEAD, and the subjects of the commits after `from`, newest first. */
  z.object({
    id: z.string(),
    method: z.literal("version.changes"),
    params: z.object({ from: CommitSchema }),
  }),
  /** Rebuild majhi from the checkout, restart it, then replace the helper. Answered before it starts. */
  z.object({ id: z.string(), method: z.literal("update"), params: z.object({}) }),
  /** Exit so launchd starts the helper again with a fresh look at Docker. Answered first. */
  z.object({ id: z.string(), method: z.literal("restart"), params: z.object({}) }),
  /** Laya's install state right now (the poll header can be up to 25 s old). */
  z.object({ id: z.string(), method: z.literal("decisions.status"), params: z.object({}) }),
  /** Installs Laya in a private venv and downloads its model. Answers with the state at once; the work goes on. */
  z.object({ id: z.string(), method: z.literal("decisions.install"), params: z.object({}) }),
  /** Asks Laya typed questions. Loads the model on the first call. */
  z.object({
    id: z.string(),
    method: z.literal("decide"),
    params: z.object({ state: z.string(), questions: z.record(z.string(), LayaQuestionSchema) }),
  }),
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
  "version.changes": z.object({
    head: z.string(),
    dirty: z.boolean(),
    changes: z.array(z.string()).max(20),
  }),
  update: z.object({ accepted: z.literal(true) }),
  restart: z.object({ accepted: z.literal(true) }),
  "decisions.status": LayaStatusSchema,
  "decisions.install": LayaStatusSchema,
  decide: LayaDecideResultSchema,
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
  /** HEAD of the majhi checkout the helper runs `docker compose` in. Absent without a checkout. */
  commit: z.string().optional(),
  /** True when that checkout has uncommitted changes. */
  dirty: z.boolean().optional(),
  dockerRuntime: DockerRuntimeSchema.optional(),
  /** Laya on this Mac. Absent from older helpers. */
  laya: LayaStatusSchema.optional(),
  /**
   * When the helper last noticed a wake from sleep (clock gap). The server resumes turns that
   * failed or stalled while the Mac slept each time this changes. Absent until the first wake.
   */
  wokeAt: z.string().optional(),
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
