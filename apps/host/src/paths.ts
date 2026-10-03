import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { HostOs } from "@majhi/shared";
import { toolDirs } from "./platform/os.ts";

/**
 * The current PATH with the OS's usual tool folders added, each folder once. A login service's PATH
 * may lack them.
 */
export function toolPath(current: string | undefined, os: HostOs, home: string): string {
  const dirs = [...(current ?? "").split(":"), ...toolDirs(os, home)].filter((d) => d !== "");
  return [...new Set(dirs)].join(":");
}

/** The absolute path of the first executable `name` on `path`, or undefined. */
export async function findExecutable(name: string, path: string): Promise<string | undefined> {
  for (const dir of path.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here. Try the next folder.
    }
  }
  return undefined;
}
