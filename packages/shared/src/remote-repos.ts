import { z } from "zod";
import { IdSchema, MrHostSchema } from "./accounts.ts";
import { GitHostNameSchema } from "./git-signin.ts";

/**
 * Remote repos a workspace's account can see, and cloning one into the workspace (org in code).
 * The clone runs on the owner's computer through the host helper, with the workspace's own
 * credential, and registers the project when it ends. See docs/briefs/onboarding-and-git-connect.md.
 *
 * Clone path rule: `<root>/<org>/<folder>`, where `<root>` is the first workspace root unless the
 * call names another, `<org>` is the workspace id (`private` for the Private workspace), and
 * `<folder>` is the repo's name unless the call names another.
 */

/** A repo's path on its host: `owner/name`, or `group/subgroup/name` on GitLab. */
export const RepoFullNameSchema = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/, "Use owner/name, like acme/api");

/** A folder name for a project under a workspace folder. One path segment, no dot folders. */
export const ProjectFolderSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "Use letters, digits, dots, dashes and underscores");

/** Where a remote repo is on this computer already. */
export const RepoHereSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }),
  /** A project of any workspace has a remote that points at this repo. */
  z.object({ state: z.literal("registered"), project: IdSchema, org: IdSchema, path: z.string() }),
  /** A repo under a workspace root has this remote, or the clone folder exists, but no project uses it. */
  z.object({ state: z.literal("cloned"), path: z.string() }),
]);
export type RepoHere = z.infer<typeof RepoHereSchema>;

export const RemoteRepoSchema = z.object({
  fullName: z.string(),
  /** The last part of `fullName`: the default folder name. */
  name: z.string(),
  /** The user, organization, group or Bitbucket workspace that owns it. */
  owner: z.string(),
  description: z.string().optional(),
  private: z.boolean(),
  /** Absent for an empty repo. */
  defaultBranch: z.string().optional(),
  /** Last push or update, as the host reports it. */
  updatedAt: z.iso.datetime({ offset: true }).optional(),
  archived: z.boolean(),
  webUrl: z.string(),
  httpsUrl: z.string(),
  sshUrl: z.string().optional(),
  here: RepoHereSchema,
});
export type RemoteRepo = z.infer<typeof RemoteRepoSchema>;

export const RemoteReposInputSchema = z.object({
  org: IdSchema,
  kind: MrHostSchema,
  /** Default: the kind's public host. */
  host: GitHostNameSchema.optional(),
  /** Matches the name and the owner, as the host's own search does. */
  query: z.string().trim().max(200).optional(),
  /** 1-based. */
  page: z.number().int().min(1).max(1000).default(1),
  perPage: z.number().int().min(1).max(100).default(30),
});

/**
 * `ok`: one page of repos the account owns, is a member of, or reaches through its organizations,
 * groups or workspaces, most recently updated first. `nextPage` is absent on the last page.
 * `signed-out`: the workspace has no token for this host; offer `git.signIn.start`.
 * `refused`: the host refused the token and refreshing did not help; offer to sign in again.
 */
export const RemoteReposSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ok"),
    account: z.string(),
    repos: z.array(RemoteRepoSchema),
    page: z.number().int().min(1),
    nextPage: z.number().int().min(2).optional(),
  }),
  z.object({ state: z.literal("signed-out"), kind: MrHostSchema, host: z.string() }),
  z.object({ state: z.literal("refused"), kind: MrHostSchema, host: z.string(), account: z.string() }),
]);
export type RemoteRepos = z.infer<typeof RemoteReposSchema>;

/** Where a new remote repo can be made: the account itself, its organizations, groups or workspaces. */
export const RemoteOwnerSchema = z.object({
  name: z.string(),
  kind: z.enum(["user", "organization", "group", "workspace"]),
});
export type RemoteOwner = z.infer<typeof RemoteOwnerSchema>;

export const RemoteOwnersSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), account: z.string(), owners: z.array(RemoteOwnerSchema) }),
  z.object({ state: z.literal("signed-out"), kind: MrHostSchema, host: z.string() }),
  z.object({ state: z.literal("refused"), kind: MrHostSchema, host: z.string(), account: z.string() }),
]);
export type RemoteOwners = z.infer<typeof RemoteOwnersSchema>;

// ---------------------------------------------------------------------------
// projects.clone / projects.cloneStatus

export const CloneIdSchema = z.string().regex(/^cl_[A-Za-z0-9]{12,32}$/, "Not a clone id");
export type CloneId = z.infer<typeof CloneIdSchema>;

/** git's own progress phases, in the order git prints them. */
export const ClonePhaseSchema = z.enum([
  "connecting",
  "counting",
  "compressing",
  "receiving",
  "resolving",
  "checkout",
]);
export type ClonePhase = z.infer<typeof ClonePhaseSchema>;

export const CloneInputSchema = z.object({
  org: IdSchema,
  kind: MrHostSchema,
  host: GitHostNameSchema.optional(),
  fullName: RepoFullNameSchema,
  /** A workspace root from majhi.yaml, as written or resolved. Default: the first one. */
  root: z.string().trim().min(1).max(4096).optional(),
  /** Default: the repo's name. */
  folder: ProjectFolderSchema.optional(),
  /** Default: from the folder name, made unique. */
  id: IdSchema.optional(),
  aliases: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(20).optional(),
  /**
   * `ssh` uses the workspace's SSH route for this host; `https` uses its token.
   * Default: `ssh` when the workspace's git account on this host has an SSH route, else `https`.
   */
  via: z.enum(["https", "ssh"]).optional(),
});
export type CloneInput = z.input<typeof CloneInputSchema>;

/** Answered at once; the job goes on. Follow it with `projects.cloneStatus` and the `clones` topic. */
export const CloneStartSchema = z.object({
  clone: CloneIdSchema,
  /** Absolute path the repo will be at. */
  path: z.string(),
  /** The project id it will be registered as. */
  project: IdSchema,
});
export type CloneStart = z.infer<typeof CloneStartSchema>;

const CloneJobBase = z.object({
  clone: CloneIdSchema,
  org: IdSchema,
  kind: MrHostSchema,
  host: z.string(),
  fullName: z.string(),
  path: z.string(),
  project: IdSchema,
  startedAt: z.iso.datetime(),
});

/**
 * A clone job: `queued` (waiting for the host helper), `cloning` (with git's phase and percent),
 * `registering` (adding the project with base = the default branch and the remote), then `done`
 * or `failed`. A failed clone leaves no folder behind. Jobs live in memory for an hour after they end.
 */
export const CloneJobSchema = z.discriminatedUnion("state", [
  CloneJobBase.extend({ state: z.literal("queued") }),
  CloneJobBase.extend({
    state: z.literal("cloning"),
    phase: ClonePhaseSchema,
    percent: z.number().int().min(0).max(100).optional(),
  }),
  CloneJobBase.extend({ state: z.literal("registering") }),
  CloneJobBase.extend({ state: z.literal("done"), endedAt: z.iso.datetime(), base: z.string() }),
  CloneJobBase.extend({
    state: z.literal("failed"),
    endedAt: z.iso.datetime(),
    /** A plain sentence. Never git's raw output, a URL with credentials or a token. */
    reason: z.string(),
  }),
]);
export type CloneJob = z.infer<typeof CloneJobSchema>;
export type CloneState = CloneJob["state"];

export const CloneStatusInputSchema = z.object({
  /** One job. Absent: every job still running or ended within the hour, newest first. */
  clone: CloneIdSchema.optional(),
});

export const CloneStatusSchema = z.object({ jobs: z.array(CloneJobSchema) });
export type CloneStatus = z.infer<typeof CloneStatusSchema>;
