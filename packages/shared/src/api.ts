import { z } from "zod";
import { ConfigPath } from "./config.ts";

export const HealthSchema = z.object({
  status: z.literal("ok"),
  version: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

/** Resolved config, with every path expanded to an absolute path. */
export const ResolvedConfigSchema = z.object({
  workspaces: z.array(z.string()),
  tasksDir: z.string(),
});
export type ResolvedConfig = z.infer<typeof ResolvedConfigSchema>;

export const ConfigStateSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("first-run"),
    file: z.string(),
    home: z.string(),
  }),
  z.object({
    status: z.literal("loaded"),
    file: z.string(),
    home: z.string(),
    config: ResolvedConfigSchema,
  }),
  z.object({
    status: z.literal("invalid"),
    file: z.string(),
    home: z.string(),
    errors: z.array(z.string()).min(1),
  }),
]);
export type ConfigState = z.infer<typeof ConfigStateSchema>;

export const GitHostSchema = z.enum(["github", "gitlab", "bitbucket", "other"]);
export type GitHost = z.infer<typeof GitHostSchema>;

export const RemoteSchema = z.object({
  name: z.string(),
  url: z.string(),
  host: GitHostSchema,
  /** SSH alias from ~/.ssh/config when the remote uses one, like `github-globex`. */
  sshAlias: z.string().optional(),
});
export type Remote = z.infer<typeof RemoteSchema>;

export const RepoSchema = z.object({
  name: z.string(),
  path: z.string(),
  /** Path relative to its workspace root. */
  relPath: z.string(),
  branch: z.string().optional(),
  remotes: z.array(RemoteSchema),
  /** True when a project in majhi.yaml points at this path. */
  registered: z.boolean(),
});
export type Repo = z.infer<typeof RepoSchema>;

export const RootScanSchema = z.object({
  path: z.string(),
  /** False when the path is not visible to the server, usually because it is not mounted yet. */
  mounted: z.boolean(),
  repos: z.array(RepoSchema),
  error: z.string().optional(),
});
export type RootScan = z.infer<typeof RootScanSchema>;

export const ReposResponseSchema = z.object({
  roots: z.array(RootScanSchema),
  scannedAt: z.string(),
  durationMs: z.number(),
});
export type ReposResponse = z.infer<typeof ReposResponseSchema>;

export const WorkspacesUpdateSchema = z.object({
  workspaces: z.array(ConfigPath).min(1, "Add at least one workspace root"),
  tasks_dir: ConfigPath.optional(),
});
export type WorkspacesUpdate = z.infer<typeof WorkspacesUpdateSchema>;

/** The command that remounts workspace roots and restarts majhi, run in the majhi folder on the host. */
export const RESTART_COMMAND = "make up";

export const WorkspacesUpdateResultSchema = z.object({
  state: ConfigStateSchema,
  /** Roots the server cannot see yet. Non-empty means the owner must restart with `make up`. */
  unmounted: z.array(z.string()),
  restartCommand: z.string(),
});
export type WorkspacesUpdateResult = z.infer<typeof WorkspacesUpdateResultSchema>;

export const ApiErrorSchema = z.object({
  error: z.string(),
  details: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
