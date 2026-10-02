import { z } from "zod";
import { IdSchema, MrHostSchema } from "./accounts.ts";
import { GitHostNameSchema } from "./git-signin.ts";
import { CleanRemoteUrlSchema } from "./host.ts";
import { ProjectFolderSchema } from "./remote-repos.ts";
import { ProjectViewSchema } from "./tasks.ts";

/**
 * A new project made by majhi, and putting it on a git host later.
 *
 * - `projects.create` (change): local only. Makes `<root>/<org>/<name>`, runs `git init` on
 *   `main`, writes a README, commits it as the workspace's identity and registers the project.
 *   The UI's "Also create it on GitHub/GitLab/Bitbucket" box (off by default) calls
 *   `projects.publish` right after, so the remote part follows the outbound approval rule.
 * - `projects.publish` (outbound): makes the remote repo with the workspace's account, sets
 *   `origin` and pushes the base branch.
 * - `projects.connectRemote` (outbound): the owner made the repo by hand and pastes its URL. majhi
 *   checks it can reach it with the workspace's credential, sets the remote, and pushes only when
 *   the remote is empty.
 */

export const ProjectCreateInputSchema = z.object({
  org: IdSchema,
  /** The folder name, and the repo name when it is published. */
  name: ProjectFolderSchema,
  /** Default: from the name, made unique. */
  id: IdSchema.optional(),
  /** A workspace root from majhi.yaml, as written or resolved. Default: the first one. */
  root: z.string().trim().min(1).max(4096).optional(),
  /** One line for the README under the title, and the remote's description when published. */
  description: z.string().trim().max(300).optional(),
  aliases: z.array(z.string().trim().toLowerCase().min(1).max(60)).max(20).optional(),
});
export type ProjectCreateInput = z.input<typeof ProjectCreateInputSchema>;

export const ProjectCreateSchema = z.object({
  project: ProjectViewSchema,
  /** The first commit on `main`. */
  commit: z.string(),
});
export type ProjectCreate = z.infer<typeof ProjectCreateSchema>;

export const ProjectPublishInputSchema = z.object({
  /** A registered project with no `origin` remote yet. */
  id: IdSchema,
  kind: MrHostSchema,
  host: GitHostNameSchema.optional(),
  /** A name from `git.remoteOwners`. Default: the signed-in account itself (its own workspace on Bitbucket). */
  owner: z.string().trim().min(1).max(255).optional(),
  /** Default: the project's folder name. */
  name: ProjectFolderSchema.optional(),
  private: z.boolean().default(true),
  description: z.string().trim().max(300).optional(),
});
export type ProjectPublishInput = z.input<typeof ProjectPublishInputSchema>;

/** The remote a project was published to or connected with. */
export const ConnectedRemoteSchema = z.object({
  /** The git remote's name, `origin` unless the call named another. */
  name: z.string(),
  /** As saved in the repo's git config: credentials are never in it. */
  url: z.string(),
  fullName: z.string().optional(),
  webUrl: z.string().optional(),
});
export type ConnectedRemote = z.infer<typeof ConnectedRemoteSchema>;

export const ProjectPublishSchema = z.object({
  project: ProjectViewSchema,
  remote: ConnectedRemoteSchema,
  /** The branch pushed, with its upstream set. */
  pushed: z.string(),
});
export type ProjectPublish = z.infer<typeof ProjectPublishSchema>;

export const ConnectRemoteInputSchema = z.object({
  id: IdSchema,
  /** https or ssh, with no user name or token in it. An ssh URL may name the workspace's SSH alias. */
  url: CleanRemoteUrlSchema,
  /** Default: `origin`. Refused when the project already has a remote of that name. */
  remote: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,60}$/, "Not a remote name")
    .optional(),
});
export type ConnectRemoteInput = z.input<typeof ConnectRemoteInputSchema>;

/**
 * `pushed`: the remote was empty, so majhi pushed the base branch and set its upstream.
 * `connected`: the remote already has branches. majhi set the remote and fetched it, pushed
 * nothing, and `detail` says what to do (for example, start a task that merges the two histories).
 */
export const ConnectRemoteSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pushed"),
    project: ProjectViewSchema,
    remote: ConnectedRemoteSchema,
    pushed: z.string(),
  }),
  z.object({
    state: z.literal("connected"),
    project: ProjectViewSchema,
    remote: ConnectedRemoteSchema,
    /** The remote's default branch. */
    remoteBranch: z.string().optional(),
    detail: z.string(),
  }),
]);
export type ConnectRemote = z.infer<typeof ConnectRemoteSchema>;
