import { z } from "zod";
import { LayaStatusSchema } from "./decisions.ts";
import { E2eRunResultSchema } from "./e2e.ts";
import { GitHostNameSchema, SignInIdSchema } from "./git-signin.ts";
import { IdSchema } from "./ids.ts";
import { CloneIdSchema, ClonePhaseSchema } from "./remote-repos.ts";
import { EditorAppSchema } from "./settings.ts";

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

/**
 * A secrets key's fingerprint: the first 16 hex characters of the SHA-256 of its
 * `AGE-SECRET-KEY-1...` line. The helper and the server compare keys by it; it never reveals the key.
 */
export const KeyFingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** The copy of the secrets key the helper keeps in the macOS Keychain. */
export const SecretsKeyBackupSchema = z.object({
  /** The fingerprint of the key in the Keychain. Absent when the Keychain holds none. */
  saved: KeyFingerprintSchema.optional(),
  /** Why the helper could not read or save the copy, in plain words. */
  error: z.string().optional(),
  checkedAt: z.string(),
});
export type SecretsKeyBackup = z.infer<typeof SecretsKeyBackupSchema>;

/** Shortest passphrase for a secrets key export. The file leaves the Mac, so it must hold up offline. */
export const KEY_EXPORT_PASSPHRASE_MIN = 12;
export const KEY_EXPORT_FILE_NAME = "majhi-secrets-key.age";

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

/** One way the Mac can act as an account on a git host. Never holds a token. */
export const GitLoginSchema = z.object({
  via: z.enum(["gh", "glab", "ssh"]),
  /** The `Host` alias of ~/.ssh/config for `ssh`. Absent for a key used with the host name itself. */
  alias: z.string().optional(),
  account: z.string(),
});
export type GitLogin = z.infer<typeof GitLoginSchema>;

export const GitHostLoginsSchema = z.object({
  /** Lowercase host name, like `github.com`. */
  host: z.string(),
  logins: z.array(GitLoginSchema),
});
export type GitHostLogins = z.infer<typeof GitHostLoginsSchema>;

export const GitLoginsResultSchema = z.object({ hosts: z.array(GitHostLoginsSchema) });
export type GitLoginsResult = z.infer<typeof GitLoginsResultSchema>;

/**
 * How the helper's git authenticates to a remote, for the jobs that clone, check or push with a
 * workspace's own credential. Platform-neutral: plain git, never a system keychain helper.
 * - `token`: https with `GIT_ASKPASS` pointing at majhi's own askpass, which prints `username` and
 *   reads `password` from a file only the owner can read (mode 600, in the helper's private folder),
 *   made for the job and removed when git exits. `-c credential.helper=` turns off every other
 *   helper, and `GIT_TERMINAL_PROMPT=0` stops prompts. The token is never in the URL, argv, the
 *   environment or a log (apps/host/src/gitAuth.ts).
 * - `ssh`: the URL names the workspace's SSH alias (`git@github-acme:acme/api.git`); the owner's
 *   own ssh config and agent do the rest. `BatchMode=yes`, so it never prompts.
 * - `none`: a public repo over https.
 */
export const GitAuthSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("token"),
    /** `x-access-token` (GitHub), `oauth2` (GitLab), `x-token-auth` (Bitbucket OAuth), or the account for a pasted Bitbucket API token. */
    username: z.string().min(1).max(255),
    /** Never logged, stored, echoed in an error or put in the URL, on either side. */
    password: z.string().min(1).max(4096),
  }),
  z.object({ kind: z.literal("ssh") }),
  z.object({ kind: z.literal("none") }),
]);
export type GitAuth = z.infer<typeof GitAuthSchema>;

/** A remote URL with no credentials in it: https without user info, or ssh (`git@host:path` or `ssh://`). */
export const CleanRemoteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((url) => !/^https?:\/\/[^/]*@/i.test(url), "Leave the user name and token out of the URL");

/** Progress of a `git.clone` job: the phase git reports. */
export const HostCloneProgressSchema = z.object({
  /** The job's id. */
  id: z.string(),
  phase: ClonePhaseSchema,
  /** 0 to 100 within the phase, when git printed one. */
  percent: z.number().int().min(0).max(100).optional(),
});
export type HostCloneProgress = z.infer<typeof HostCloneProgressSchema>;

/**
 * Progress of a `git.cliLogin` job: the page the CLI wants opened, and for `gh` the one-time code
 * the owner types there. Neither is a secret on its own; the token never travels as progress.
 */
export const HostLoginProgressSchema = z.object({
  id: z.string(),
  login: z.object({
    url: z.url({ protocol: /^https?$/ }).max(4096),
    code: z
      .string()
      .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
      .optional(),
  }),
});
export type HostLoginProgress = z.infer<typeof HostLoginProgressSchema>;

/**
 * Progress of a long job, posted by the helper to `POST /api/host/progress` while the job runs:
 * `git.clone` phases, or the page and code of a `git.cliLogin`. The server drops progress for a
 * job nobody waits for.
 */
export const HostProgressSchema = z.union([HostCloneProgressSchema, HostLoginProgressSchema]);
export type HostProgress = z.infer<typeof HostProgressSchema>;

/** The git host CLIs majhi signs in with. */
export const GitCliSchema = z.enum(["gh", "glab"]);
export type GitCli = z.infer<typeof GitCliSchema>;

/**
 * What a `git.cliLogin` ended with.
 * - `missing`: the CLI is not installed on this computer. Nothing ran.
 * - `done`: the CLI signed in. `token` (and for glab its OAuth refresh token and expiry) go
 *   straight into one workspace's secrets: never logged, cached or echoed.
 * - `cancelled`: `git.cliLoginCancel` stopped it.
 */
export const GitCliLoginResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("missing") }),
  z.object({
    state: z.literal("done"),
    token: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(4096).optional(),
    /** When the access token stops working, from glab's config. */
    expiresAt: z.iso.datetime({ offset: true }).optional(),
  }),
  z.object({ state: z.literal("cancelled") }),
]);
export type GitCliLoginResult = z.infer<typeof GitCliLoginResultSchema>;

/** Longest path the editor jobs take. */
export const EDITOR_PATH_MAX = 4096;

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
  /** Open a file, worktree or project folder in the owner's editor. `line` only applies to a file. */
  z.object({
    id: z.string(),
    method: z.literal("editor.open"),
    params: z.object({
      app: EditorAppSchema,
      path: z.string().min(1).max(EDITOR_PATH_MAX),
      line: z.number().int().min(1).optional(),
    }),
  }),
  /**
   * Run the project's Playwright suite in the helper's own worktree at `commit`, at low priority, and
   * answer when it ends (the call waits up to `timeoutMs`). `repo` is the project's path, the same on
   * the Mac and in the container. Never touches that checkout, ~/.majhi/majhi.db or port 7070.
   */
  z.object({
    id: z.string(),
    method: z.literal("e2e.run"),
    params: z.object({
      runId: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[A-Za-z0-9-]+$/),
      repo: z.string().min(1).max(EDITOR_PATH_MAX),
      commit: CommitSchema,
      timeoutMs: z
        .number()
        .int()
        .min(60_000)
        .max(6 * 60 * 60_000),
    }),
  }),
  /**
   * Show a macOS notification. `path` is where a click leads in majhi, like `/t/ACM-12`; the helper
   * joins it to majhi's own address and only opens it when it can carry a click.
   */
  z.object({
    id: z.string(),
    method: z.literal("notify"),
    params: z.object({
      title: z.string().min(1).max(120),
      message: z.string().min(1).max(300),
      path: z
        .string()
        .max(300)
        .regex(/^\/(?!\/)/)
        .optional(),
      sound: z.boolean(),
    }),
  }),
  /** Which accounts `gh`, `glab` and the SSH keys are logged in as, per git host. Reads no token. */
  z.object({
    id: z.string(),
    method: z.literal("git.logins"),
    params: z.object({ extraHosts: z.array(z.string().max(255)).max(50) }),
  }),
  /**
   * Reads the token of a `gh` or `glab` login. Only the owner's "Use it" click may send it, and the
   * result must go straight into one org's secrets: never logged, cached or echoed.
   */
  z.object({
    id: z.string(),
    method: z.literal("git.token"),
    params: z.object({ via: z.enum(["gh", "glab"]), host: z.string().min(1).max(255) }),
  }),
  /**
   * `git push <url> <branch>` from the owner's computer, so its saved https login supplies the
   * credential. Never forces, never prompts. The path is the same there and in the container.
   * With `auth` (a token), the workspace's own credential is used instead and no system helper is
   * asked (Ship, publish and connect a remote); `setUpstream` also points the branch's upstream at
   * the remote whose URL this is.
   */
  z.object({
    id: z.string(),
    method: z.literal("git.push"),
    params: z.object({
      path: z.string().min(1).max(4096),
      url: z.string().min(1).max(2048),
      branch: z.string().min(1).max(255),
      auth: GitAuthSchema.optional(),
      setUpstream: z.boolean().optional(),
    }),
  }),
  /**
   * Open a web page in the owner's default browser: macOS `open`, Linux `xdg-open`, WSL `wslview`
   * (else `explorer.exe`). Only http(s) URLs. `opened` is false when nothing could open it; the UI
   * then shows the link to click.
   */
  z.object({
    id: z.string(),
    method: z.literal("openUrl"),
    params: z.object({ url: z.url({ protocol: /^https?$/ }).max(4096) }),
  }),
  /**
   * Sign a workspace in to a git host with the host's own CLI in the browser: `gh auth login --web`
   * or `glab auth login --web`. The CLI runs with a config folder of the workspace's own
   * (`<MAJHI_HOME>/git/<org>/<cli>`, mode 700, never the owner's own CLI login), stores the token
   * in that folder only (never a system keyring), and the folder is removed when the job ends.
   * Posts `HostLoginProgress` once the page is known. Ends `missing` when the CLI is not installed.
   * `signIn` names the job for `git.cliLoginCancel`.
   */
  z.object({
    id: z.string(),
    method: z.literal("git.cliLogin"),
    params: z.object({
      signIn: SignInIdSchema,
      cli: GitCliSchema,
      org: IdSchema,
      host: GitHostNameSchema,
    }),
  }),
  /** Stops the `git.cliLogin` of this sign-in: kills the CLI. `cancelled` is false when none ran. */
  z.object({
    id: z.string(),
    method: z.literal("git.cliLoginCancel"),
    params: z.object({ signIn: SignInIdSchema }),
  }),
  /**
   * `git clone` a remote into `path` with the workspace's credential, posting `HostProgress` as it
   * goes. Clones into a temporary sibling folder and renames it to `path` only when it finished,
   * so a failed clone leaves nothing behind. Refuses when `path` exists and is not empty. Never
   * prompts. The path is the same on the owner's computer and in the container.
   */
  z.object({
    id: z.string(),
    method: z.literal("git.clone"),
    params: z.object({
      clone: CloneIdSchema,
      url: CleanRemoteUrlSchema,
      path: z.string().min(1).max(4096),
      /** Check out this branch. Default: the remote's default branch. */
      branch: z.string().min(1).max(255).optional(),
      auth: GitAuthSchema,
    }),
  }),
  /** `git ls-remote --symref` with the workspace's credential: whether the remote is reachable and empty. */
  z.object({
    id: z.string(),
    method: z.literal("git.lsRemote"),
    params: z.object({ url: CleanRemoteUrlSchema, auth: GitAuthSchema }),
  }),
  /**
   * Asks the Mac's git credential helper (`git credential fill`) for the saved https secret of one
   * host and account. Only the owner's click may send it; the result goes straight to an API check
   * and then one org's secrets: never logged, cached or echoed.
   */
  z.object({
    id: z.string(),
    method: z.literal("git.credential"),
    params: z.object({ host: z.string().min(1).max(255), username: z.string().min(1).max(255) }),
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
  /**
   * Save the Mac's secrets key file to the Keychain, replacing any other key there. The helper refuses
   * when the file's fingerprint is not `expected`, the key the server uses. The key never travels.
   */
  z.object({
    id: z.string(),
    method: z.literal("secretsKey.save"),
    params: z.object({ expected: KeyFingerprintSchema }),
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
  "secretsKey.save": SecretsKeyBackupSchema,
  "version.changes": z.object({
    head: z.string(),
    dirty: z.boolean(),
    changes: z.array(z.string()).max(20),
  }),
  "editor.open": z.object({ opened: z.literal(true) }),
  "e2e.run": E2eRunResultSchema,
  /** `clickable`: a click on the notification opens majhi. */
  notify: z.object({ shown: z.literal(true), clickable: z.boolean() }),
  "git.logins": GitLoginsResultSchema,
  "git.token": z.object({ token: z.string().min(1) }),
  "git.push": z.object({ pushed: z.literal(true) }),
  openUrl: z.object({ opened: z.boolean() }),
  /** `head`: the commit checked out. `branch`: the branch checked out, the remote's default unless one was named. */
  "git.clone": z.object({ head: CommitSchema, branch: z.string() }),
  /** `empty`: the remote has no branches. `defaultBranch`: where its HEAD points, when it has one. */
  "git.lsRemote": z.object({ empty: z.boolean(), defaultBranch: z.string().optional() }),
  "git.cliLogin": GitCliLoginResultSchema,
  "git.cliLoginCancel": z.object({ cancelled: z.boolean() }),
  "git.credential": z.object({ secret: z.string().min(1) }),
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
  /** The Keychain copy of the secrets key. Absent until the helper's first look, off macOS, and from older helpers. */
  secretsKey: SecretsKeyBackupSchema.optional(),
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
