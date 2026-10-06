import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withGitConfig } from "@majhi/acp";
import { writeFileAtomic } from "../fs.ts";
import { git } from "./git.ts";
import { EXCLUDES_FILE } from "./repo-config.ts";

/**
 * Package stores and caches that never belong in a task branch. A task worktree ignores them even
 * when the project's own `.gitignore` does not, so a checkpoint or an agent's `git add` cannot
 * commit thousands of cache files.
 *
 * The list lives in a file next to the worktree's own git entry. Nothing is written into the repo's
 * config or into `.git/info/exclude` (git shares it between a repo's checkouts, so it would change
 * the owner's own checkout). Every git command that should honour the file gets it as
 * `core.excludesFile` from outside: majhi's git helper (`worktreeExcludes`) and the environment of
 * runs, hand-off checks and the task terminal (`excludesEnv`). The file starts with the owner's own
 * global ignore patterns, because `core.excludesFile` replaces that setting.
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

/** What one repo's tracked files say: which languages it has, and the path segments of each file. */
interface Tracked {
  languages: Set<Language>;
  paths: string[][];
}

function readTracked(files: readonly string[]): Tracked {
  const languages = new Set<Language>();
  const paths: string[][] = [];
  for (const file of files) {
    const segments = file.split("/");
    const marker = LANGUAGE_MARKERS.get(segments[segments.length - 1] ?? "");
    if (marker !== undefined) languages.add(marker);
    paths.push(segments);
  }
  return { languages, paths };
}

function containsRun(path: readonly string[], run: readonly string[]): boolean {
  for (let i = 0; i + run.length <= path.length; i++) {
    if (run.every((segment, j) => path[i + j] === segment)) return true;
  }
  return false;
}

/**
 * The exclude lines for the tracked files of a task's repos (one list per repo; one repo is the
 * usual case). A folder any repo tracks something in is never excluded, and a language rule applies
 * only when every repo has that language, so no repo's own files are hidden by another's rules.
 */
export function excludeLines(repos: readonly (readonly string[])[]): string[] {
  const read = repos.map(readTracked);
  const lines = new Set<string>();
  for (const rule of EXCLUDE_RULES) {
    const only = rule.only;
    if (only !== undefined && !read.every((r) => only.some((l) => r.languages.has(l)))) continue;
    if (read.some((r) => r.paths.some((path) => containsRun(path, rule.folder)))) continue;
    lines.add(`**/${rule.folder.join("/")}/`);
  }
  return [...lines];
}

/** The owner's global ignore file, as git reads it: `core.excludesFile`, else the XDG default. */
async function ownerExcludes(cwd: string): Promise<string> {
  const set = (await git(cwd, ["config", "--global", "--get", "core.excludesFile"]).catch(() => "")).trim();
  const file =
    set === ""
      ? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "ignore")
      : set.startsWith("~/")
        ? join(homedir(), set.slice(2))
        : set;
  return readFile(file, "utf8").catch(() => "");
}

/**
 * Writes the exclude file of each linked worktree given (the worktrees of one task) and returns the
 * path of the first, which holds what every one holds. Safe to repeat: a file is written only when
 * it differs. A main checkout (the owner's own) is skipped, because for it the git dir and the
 * common dir are the same. Undefined when there is no linked worktree.
 */
export async function ensureWorktreeExcludes(worktrees: readonly string[]): Promise<string | undefined> {
  const linked: { worktree: string; file: string }[] = [];
  for (const worktree of worktrees) {
    const dirs = await gitDirs(worktree);
    if (dirs !== undefined) linked.push({ worktree, file: join(dirs.own, EXCLUDES_FILE) });
  }
  const first = linked[0];
  if (first === undefined) return undefined;
  const tracked = await Promise.all(
    linked.map(async ({ worktree }) =>
      (await git(worktree, ["ls-files", "-z"])).split("\0").filter((f) => f !== ""),
    ),
  );
  const own = (await ownerExcludes(first.worktree)).trimEnd();
  const body = `${own === "" ? "" : `${own}\n\n`}# majhi: package stores and caches\n${excludeLines(tracked).join("\n")}\n`;
  for (const { file } of linked) {
    if ((await readFile(file, "utf8").catch(() => undefined)) !== body) await writeFileAtomic(file, body);
  }
  return first.file;
}

/**
 * `env` with `core.excludesFile` added as a command-line git setting, after whatever
 * `GIT_CONFIG_COUNT` entries it already has, so git in the task's worktrees honours the exclude
 * file. The path is the same inside a run, which mounts the worktree's git entry at its own path.
 * `env` unchanged when the task has no linked worktree or the file cannot be written.
 */
export async function withExcludes(
  env: Readonly<Record<string, string>>,
  worktrees: readonly string[],
): Promise<Record<string, string>> {
  const file = await ensureWorktreeExcludes(worktrees).catch(() => undefined);
  return file === undefined ? { ...env } : withGitConfig(env, [["core.excludesFile", file]]);
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
