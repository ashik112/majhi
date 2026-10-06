import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../fs.ts";
import { git } from "./git.ts";

/**
 * Package stores and caches that never belong in a task branch. A task worktree ignores them even
 * when the project's own `.gitignore` does not, so a checkpoint or an agent's `git add` cannot
 * commit thousands of cache files.
 *
 * The list lives in a file next to the worktree's own git entry, which `core.excludesFile` points
 * to through the worktree's own config. `.git/info/exclude` is not used: git shares it between a
 * repo's checkouts, so a line there would also change the owner's own checkout.
 */

type Language = "rust" | "java";

interface ExcludeRule {
  /** A folder, as path segments from anywhere below the worktree's top. */
  folder: readonly string[];
  /** Applies only to a repo of one of these languages (their build output has a common name). */
  only?: readonly Language[];
}

export const EXCLUDE_RULES: readonly ExcludeRule[] = [
  { folder: [".pnpm-store"] },
  { folder: ["node_modules"] },
  { folder: [".venv"] },
  { folder: ["venv"] },
  { folder: ["__pycache__"] },
  { folder: [".pytest_cache"] },
  { folder: [".mypy_cache"] },
  { folder: [".ruff_cache"] },
  { folder: [".gradle"] },
  { folder: [".m2"] },
  { folder: ["target"], only: ["rust", "java"] },
  { folder: [".next", "cache"] },
  { folder: [".turbo"] },
  { folder: [".parcel-cache"] },
  { folder: ["coverage"] },
];

/** File names whose presence in the repo says what language it is. */
const LANGUAGE_MARKERS: ReadonlyMap<string, Language> = new Map([
  ["Cargo.toml", "rust"],
  ["pom.xml", "java"],
  ["build.gradle", "java"],
  ["build.gradle.kts", "java"],
]);

/** What a repo's tracked files say: which languages it has, and which folders hold tracked files. */
function readTracked(files: readonly string[]): { languages: Set<Language>; tracked: string[][] } {
  const languages = new Set<Language>();
  const tracked: string[][] = [];
  for (const file of files) {
    const segments = file.split("/");
    const marker = LANGUAGE_MARKERS.get(segments[segments.length - 1] ?? "");
    if (marker !== undefined) languages.add(marker);
    tracked.push(segments);
  }
  return { languages, tracked };
}

function containsRun(path: readonly string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= path.length; i++) {
    if (run.every((segment, j) => path[i + j] === segment)) return true;
  }
  return false;
}

/**
 * The exclude lines for a repo with these tracked files: every rule that applies to its language,
 * minus any folder the repo tracks something in. A tracked folder is never excluded.
 */
export function excludeLines(trackedFiles: readonly string[]): string[] {
  const { languages, tracked } = readTracked(trackedFiles);
  const lines = new Set<string>();
  for (const rule of EXCLUDE_RULES) {
    if (rule.only !== undefined && !rule.only.some((l) => languages.has(l))) continue;
    if (tracked.some((path) => containsRun(path, rule.folder))) continue;
    lines.add(`**/${rule.folder.join("/")}/`);
  }
  return [...lines];
}

const FILE_NAME = "majhi-exclude";

/**
 * Makes a linked task worktree ignore the standard caches, and does nothing else. Safe to repeat:
 * it writes the file and the config only when they differ. A main checkout (the owner's own) is
 * never touched, because for it the git dir and the common dir are the same.
 */
export async function ensureWorktreeExcludes(worktree: string): Promise<void> {
  const dirs = await gitDirs(worktree);
  if (dirs === undefined) return;
  const tracked = (await git(worktree, ["ls-files", "-z"])).split("\0").filter((f) => f !== "");
  const body = `${excludeLines(tracked).join("\n")}\n`;
  const file = join(dirs.own, FILE_NAME);
  const current = await readIfThere(file);
  if (current !== body) await writeFileAtomic(file, body);
  if ((await configValue(worktree, ["extensions.worktreeConfig"])) !== "true") {
    await git(worktree, ["config", "extensions.worktreeConfig", "true"]);
  }
  if ((await configValue(worktree, ["--worktree", "core.excludesFile"])) !== file) {
    await git(worktree, ["config", "--worktree", "core.excludesFile", file]);
  }
}

/** The worktree's own git dir, or undefined when `worktree` is a main checkout or not a repo. */
async function gitDirs(worktree: string): Promise<{ own: string } | undefined> {
  const out = await git(worktree, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]).catch(() => "");
  const [own, common] = out.split("\n").map((l) => l.trim());
  if (own === undefined || common === undefined || own === "" || own === common) return undefined;
  return { own };
}

async function configValue(worktree: string, args: readonly string[]): Promise<string | undefined> {
  const out = await git(worktree, ["config", "--get", ...args]).catch(() => "");
  return out.trim() === "" ? undefined : out.trim();
}

async function readIfThere(path: string): Promise<string | undefined> {
  return readFile(path, "utf8").catch(() => undefined);
}
