import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/**
 * A fast look at a repo's own config files, so majhi's git does not start `git config` before every
 * command. It answers one question: does the repo's local or worktree config set none of the keys
 * `repoCommands` turns off? When it cannot tell, it says no and git is asked. It never says yes
 * for a config it did not read in full, so a planted filter, driver or signing program is never missed.
 */

/** A key `repoCommands` reads, as a lowercase `section.name` or `section.subsection.name`. */
const WATCHED: readonly RegExp[] = [
  /^filter\..+\.(clean|smudge|process)$/,
  /^merge\..+\.driver$/,
  /^credential\.(.+\.)?helper$/,
  /^remote\..+\.(uploadpack|receivepack)$/,
  /^core\.(askpass|alternaterefscommand|gitproxy)$/,
  /^gpg\.((openpgp|x509|ssh)\.)?program$/,
  /^gpg\.ssh\.defaultkeycommand$/,
  /^log\.showsignature$/,
  /^merge\.verifysignatures$/,
  /^(commit|tag|push)\.gpgsign$/,
  /^tag\.forcesignannotated$/,
];

const HEADER = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/;
const ASSIGN = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=.*)?$/;

/**
 * True when the config text sets none of the watched keys. False when it does, includes another
 * file, or has anything this reader does not understand (a value that continues on the next line,
 * an odd header).
 */
export function configIsPlain(text: string): boolean {
  let section: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    for (;;) {
      if (line.endsWith("\\")) return false;
      if (line.startsWith("[")) {
        const header = HEADER.exec(line);
        if (header === null) return false;
        const name = (header[1] ?? "").toLowerCase();
        if (name === "include" || name === "includeif") return false;
        section = header[2] === undefined ? name : `${name}.${header[2]}`;
        line = (header[3] ?? "").trim();
        if (line === "" || line.startsWith("#") || line.startsWith(";")) break;
        continue;
      }
      const assign = ASSIGN.exec(line);
      if (assign === null || section === undefined) return false;
      const key = `${section}.${(assign[1] ?? "").toLowerCase()}`.toLowerCase();
      if (WATCHED.some((w) => w.test(key))) return false;
      break;
    }
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** The git folders of a work tree: its own, and the one it shares with its other worktrees. */
export interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/**
 * The git folders of `cwd` when it is the top of a work tree (a repo or a linked worktree), read from
 * the files git itself keeps. Nothing for a subfolder, a bare repo, or a `GIT_DIR` in the environment:
 * callers then ask git.
 */
export async function gitDirsOf(cwd: string, env: NodeJS.ProcessEnv): Promise<GitDirs | undefined> {
  try {
    for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS"]) {
      if (env[name] !== undefined) return undefined;
    }
    const dotGit = join(cwd, ".git");
    const info = await stat(dotGit);
    let gitDir = dotGit;
    if (info.isFile()) {
      const pointer = (await readFile(dotGit, "utf8")).trim();
      if (!pointer.startsWith("gitdir:")) return undefined;
      const target = pointer.slice("gitdir:".length).trim();
      gitDir = isAbsolute(target) ? target : resolve(cwd, target);
    } else if (!info.isDirectory()) {
      return undefined;
    }
    let commonDir = gitDir;
    const common = await readFile(join(gitDir, "commondir"), "utf8").catch(() => undefined);
    if (common !== undefined) {
      const target = common.trim();
      commonDir = isAbsolute(target) ? target : resolve(gitDir, target);
    }
    return { gitDir, commonDir };
  } catch {
    return undefined;
  }
}

/**
 * Whether `cwd` is the top of a work tree whose local and worktree config files set none of the
 * watched keys. False for anything `gitDirsOf` does not answer for, and for a config that includes
 * another file.
 */
export async function repoConfigIsPlain(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const dirs = await gitDirsOf(cwd, env);
    if (dirs === undefined) return false;
    const { gitDir, commonDir } = dirs;
    const files = [join(commonDir, "config"), join(gitDir, "config.worktree")];
    if (commonDir !== gitDir) files.push(join(commonDir, "config.worktree"));
    if (!(await exists(files[0] as string))) return false;
    for (const file of files) {
      const text = await readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return "";
        throw err;
      });
      if (!configIsPlain(text)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The file next to a linked worktree's own git entry that holds its cache excludes. */
export const EXCLUDES_FILE = "majhi-exclude";

/**
 * The cache-excludes file of `cwd` when it is the top of a linked task worktree that has one. majhi's
 * git passes it as `core.excludesFile`, so nothing is written into the repo's config. The owner's own
 * checkout (git dir and common dir the same) never has one.
 */
export async function worktreeExcludes(cwd: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dirs = await gitDirsOf(cwd, env);
  if (dirs === undefined || dirs.gitDir === dirs.commonDir) return undefined;
  const file = join(dirs.gitDir, EXCLUDES_FILE);
  return (await exists(file)) ? file : undefined;
}
