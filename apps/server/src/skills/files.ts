import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { SKILL_MAX_BYTES, SKILL_MAX_FILES, type SkillFile } from "@majhi/shared";
import { UserError } from "../errors.ts";

/** True when `child` is `parent` or lies inside it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** One file of a skill folder: where it is now and where it goes, relative to the skill. */
interface Entry {
  from: string;
  path: string;
  size: number;
  executable: boolean;
}

/**
 * Walks a folder and lists its files. Paths stay inside it: a symlink is followed only when its
 * target is a file inside the folder, and a link to anything else, a folder or something outside is
 * refused. Hidden `.git` folders are skipped. The count and the total size are capped.
 */
async function walk(root: string): Promise<Entry[]> {
  const base = await realpath(root);
  const out: Entry[] = [];
  let total = 0;
  const visit = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      if (name === ".git" || name === "node_modules") continue;
      if (name === "." || name === ".." || name.includes("\0") || name.includes("\\")) {
        throw new UserError(`The skill has a file name that is not allowed: ${JSON.stringify(name)}.`);
      }
      const path = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      let info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await realpath(path).catch(() => undefined);
        if (target === undefined || !isInside(target, base)) {
          throw new UserError(`${rel} is a link that points outside the skill. Skills cannot link out.`);
        }
        info = await stat(target);
        if (info.isDirectory())
          throw new UserError(`${rel} is a link to a folder, which a skill cannot hold.`);
      }
      if (info.isDirectory()) {
        await visit(path, rel);
      } else if (info.isFile()) {
        total += info.size;
        if (out.length >= SKILL_MAX_FILES) {
          throw new UserError(`The skill has more than ${SKILL_MAX_FILES} files.`);
        }
        if (total > SKILL_MAX_BYTES) {
          throw new UserError(`The skill is bigger than ${SKILL_MAX_BYTES / 1024 / 1024} MB.`);
        }
        out.push({ from: path, path: rel, size: info.size, executable: (info.mode & 0o111) !== 0 });
      } else {
        throw new UserError(`${rel} is not a regular file.`);
      }
    }
  };
  await visit(base, "");
  return out;
}

/** The files of a skill folder, sorted, and a SHA-256 over their paths and contents. */
export async function describeFolder(root: string): Promise<{ files: SkillFile[]; hash: string }> {
  const entries = await walk(root);
  const hash = createHash("sha256");
  for (const e of entries) {
    hash.update(`${e.path}\0${e.size}\0`);
    hash.update(await readFile(e.from));
  }
  return { files: entries.map((e) => ({ path: e.path, size: e.size })), hash: hash.digest("hex") };
}

/**
 * Copies a skill folder to `to` (which must not exist yet) with the same containment rules as
 * `describeFolder`: links are copied as the files they point to, and nothing outside the folder is read.
 */
export async function copyFolder(from: string, to: string): Promise<void> {
  const entries = await walk(from);
  await mkdir(to, { recursive: true, mode: 0o755 });
  for (const e of entries) {
    const dest = join(to, ...e.path.split("/"));
    if (!isInside(dest, to)) throw new UserError(`${e.path} would land outside the skill folder.`);
    await mkdir(dirname(dest), { recursive: true, mode: 0o755 });
    await copyFile(e.from, dest);
  }
}
