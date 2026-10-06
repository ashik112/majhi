import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunMount } from "@majhi/acp";
import { PRIVATE, type Task } from "@majhi/shared";

/**
 * One shared, content-addressed package store per workspace (5.4). Installs in a workspace's tasks
 * hard-link from it instead of downloading and unpacking per task, and nothing writes a
 * `.pnpm-store` inside a task folder any more. The store lives in `<majhiHome>/cache/<org>/`
 * (git-ignored, not backed up). A run mounts only its own workspace's folder, never `cache/` itself.
 */

const ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The workspace a task's packages belong to: its org, else Private. */
export const cacheOrgOf = (task: Pick<Task, "org">): string => task.org ?? PRIVATE;

/** `<majhiHome>/cache/<org>`: the one folder a run of that workspace may mount. */
export function cacheRoot(majhiHome: string, org: string): string {
  if (!ORG.test(org)) throw new Error(`Not a workspace id: ${org}`);
  return join(majhiHome, "cache", org);
}

/**
 * The variables that point every package manager at the workspace store. Only these reach the run,
 * built here from the folder: majhi's own environment is never copied in.
 */
export function cacheEnv(root: string): Record<string, string> {
  const pnpm = join(root, "pnpm-store");
  return {
    // pnpm reads npm_config_store_dir; PNPM_STORE_DIR is for tools that read it directly.
    npm_config_store_dir: pnpm,
    PNPM_STORE_DIR: pnpm,
    npm_config_cache: join(root, "npm"),
    YARN_CACHE_FOLDER: join(root, "yarn"),
    PIP_CACHE_DIR: join(root, "pip"),
  };
}

/** The mount and variables that put a process's package installs in the workspace store. */
export interface PackageStore {
  mounts: RunMount[];
  env: Record<string, string>;
  /** A home folder inside the mounted store, for a process that has no account home: tools keep their caches there. */
  home: string;
}

/** Looks up the store for a task. Undefined when it cannot be made: the process then runs without. */
export type PackageStoreFor = (task: Task) => Promise<PackageStore | undefined>;

/** The mount and variables a run of `task` gets, with the folders made. */
export async function packageCache(majhiHome: string, task: Pick<Task, "org">): Promise<PackageStore> {
  const root = cacheRoot(majhiHome, cacheOrgOf(task));
  const env = cacheEnv(root);
  const home = join(root, "home");
  await Promise.all([...Object.values(env), home].map((dir) => mkdir(dir, { recursive: true })));
  return { mounts: [{ path: root }], env, home };
}
