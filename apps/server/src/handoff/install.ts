import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * A project's manifest and the folders its installed packages land in. A worktree of a task starts
 * without them (they are not in git), so a check that runs a build there fails on a missing package,
 * not on the work. Read from the folder's shape, never from a message.
 */
const PROJECTS: readonly { manifest: string; installed: readonly string[] }[] = [
  { manifest: "package.json", installed: ["node_modules"] },
  { manifest: "pyproject.toml", installed: [".venv", "venv"] },
  { manifest: "requirements.txt", installed: [".venv", "venv"] },
  { manifest: "composer.json", installed: ["vendor"] },
];

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

/** True when a worktree has a manifest at its root whose packages are not installed. */
export async function dependenciesMissing(worktree: string): Promise<boolean> {
  for (const { manifest, installed } of PROJECTS) {
    if (!(await exists(join(worktree, manifest)))) continue;
    const present = await Promise.all(installed.map((dir) => exists(join(worktree, dir))));
    if (!present.some(Boolean)) return true;
  }
  return false;
}
