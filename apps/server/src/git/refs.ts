import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gitDirsOf } from "./repo-config.ts";

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Whether the full ref name (`refs/heads/main`) exists, read from the files git keeps its refs in:
 * the loose file, else the `packed-refs` list. The same answer as `git show-ref --verify`, without
 * starting git. Undefined when the files cannot settle it (a subfolder or bare repo, reftable refs, a
 * symbolic or unreadable ref file, an odd name), and the caller then asks git.
 */
export async function refExists(cwd: string, ref: string): Promise<boolean | undefined> {
  const id = await refId(cwd, ref);
  return id === undefined ? undefined : id !== false;
}

/**
 * The commit a full ref name points at, read from the same files as `refExists`. False when the ref is
 * not there, undefined when the files cannot settle it.
 */
export async function refId(cwd: string, ref: string): Promise<string | false | undefined> {
  try {
    if (!ref.startsWith("refs/") || ref.includes("\0") || ref.includes("//") || ref.endsWith("/")) {
      return undefined;
    }
    if (ref.split("/").some((part) => part === ".." || part === "." || part.endsWith(".lock"))) {
      return undefined;
    }
    const dirs = await gitDirsOf(cwd, process.env);
    if (dirs === undefined) return undefined;
    if (await isDir(join(dirs.commonDir, "reftable"))) return undefined;
    const loose = await stat(join(dirs.commonDir, ref)).catch(() => undefined);
    if (loose?.isFile()) {
      const text = (await readFile(join(dirs.commonDir, ref), "utf8")).trim();
      return OBJECT_ID.test(text) ? text : undefined;
    }
    const packed = await readFile(join(dirs.commonDir, "packed-refs"), "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return "";
        throw err;
      },
    );
    for (const line of packed.split("\n")) {
      const space = line.indexOf(" ");
      if (space > 0 && line.slice(space + 1) === ref && OBJECT_ID.test(line.slice(0, space))) {
        return line.slice(0, space);
      }
    }
    return false;
  } catch {
    return undefined;
  }
}

async function isDir(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isDirectory() === true;
}
