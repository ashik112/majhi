import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunMount } from "@majhi/acp";
import type { Task } from "@majhi/shared";
import { cacheOrgOf } from "./package-cache.ts";

/**
 * One persistent tools folder per workspace, `<majhiHome>/tools/<org>`. Agents install command-line
 * tools into its `bin` (release binaries, no sudo) and later runs of the same workspace find them
 * on PATH. A run mounts only its own workspace's folder, never `tools` itself.
 */

const ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function toolsRoot(majhiHome: string, org: string): string {
  if (!ORG.test(org)) throw new Error(`Not a workspace id: ${org}`);
  return join(majhiHome, "tools", org);
}

/** The mount and variable a run of `task` gets, with the folder made. The runtime puts its `bin` first on PATH. */
export async function toolsFolder(
  majhiHome: string,
  task: Pick<Task, "org">,
): Promise<{ mounts: RunMount[]; env: Record<string, string> }> {
  const root = toolsRoot(majhiHome, cacheOrgOf(task));
  await mkdir(join(root, "bin"), { recursive: true });
  return { mounts: [{ path: root }], env: { MAJHI_TOOLS: root } };
}
