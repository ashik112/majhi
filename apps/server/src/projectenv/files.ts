import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { fsRepoFiles } from "../projectcard/files.ts";
import type { PlanFiles } from "./python.ts";

/** A lock file bigger than this does not name an environment. */
const MAX_DIGEST_BYTES = 32 * 1024 * 1024;

/**
 * A worktree's files for the plan: the scanner's reader (no symlinks, nothing outside the root, no secret
 * files) and the digest of a file of any size inside the root, which keeps a big lock file in the key.
 */
export function planFilesOf(root: string): PlanFiles {
  let real: string | undefined;
  return {
    ...fsRepoFiles(root),
    async digest(rel) {
      if (rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
      try {
        real ??= await realpath(root);
        const path = join(root, rel);
        const info = await lstat(path);
        if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_DIGEST_BYTES) return undefined;
        const target = await realpath(path);
        if (target !== real && !target.startsWith(real + sep)) return undefined;
        return createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      } catch {
        return undefined;
      }
    },
  };
}
