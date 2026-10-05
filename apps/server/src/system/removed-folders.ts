import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { errorMessage } from "../errors.ts";

/**
 * Folders of features majhi no longer has, relative to the majhi home. This list is the only thing
 * that is ever removed: a name is never read from disk or from data, so nothing else can be deleted.
 * `e2e` is the old background e2e runner (runs, traces, a checkout); `business/kb` is the removed
 * business knowledge base.
 */
export const REMOVED_FOLDERS = ["e2e", "business/kb"] as const;

export interface RemovedFolder {
  folder: string;
  /** Bytes were not counted; majhi only says it was removed. */
  removed: boolean;
  /** Why it was kept, when it was. */
  kept?: string;
}

/**
 * Removes the folders of removed features from the majhi home, once at startup. A folder that is
 * missing is skipped. A symbolic link, or a folder whose real path leaves the home, is never followed
 * or removed. Each removal is logged and a failure never stops majhi from starting.
 */
export async function removeLeftoverFolders(
  home: string,
  log: (line: string) => void = (line) => console.log(line),
): Promise<RemovedFolder[]> {
  const base = resolve(home);
  const baseReal = await realpath(base).catch(() => undefined);
  if (baseReal === undefined) return [];
  const out: RemovedFolder[] = [];
  for (const folder of REMOVED_FOLDERS) {
    const path = join(base, folder);
    try {
      const info = await lstat(path).catch(() => undefined);
      if (info === undefined) continue;
      if (info.isSymbolicLink() || !info.isDirectory()) {
        out.push({ folder, removed: false, kept: "it is not a plain folder" });
        log(`majhi kept ${path}: it is not a plain folder`);
        continue;
      }
      const real = await realpath(path);
      if (!real.startsWith(baseReal + sep)) {
        out.push({ folder, removed: false, kept: "it is outside the majhi home" });
        log(`majhi kept ${path}: it is outside the majhi home`);
        continue;
      }
      await rm(real, { recursive: true, force: true });
      out.push({ folder, removed: true });
      log(`majhi removed ${path}, left over from a removed feature`);
    } catch (err) {
      out.push({ folder, removed: false, kept: errorMessage(err) });
      log(`majhi could not remove ${path}: ${errorMessage(err)}`);
    }
  }
  return out;
}
