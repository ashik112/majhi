import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { CiCommand } from "../ci/jobs.ts";
import type { RepoFiles } from "../projectcard/files.ts";
import { parseRequirements, pythonName } from "../wiki/facts/formats.ts";
import { resolveInRepo } from "../wiki/facts/read.ts";
import { isDebianPackage, systemFor } from "./system-needs.ts";

/**
 * What a Python project installs, read from the project's own files and never guessed from text: the install
 * step of its CI file (or the project card's install command), else its requirements, `uv.lock` or
 * `pyproject.toml`. The result is a typed plan; `build.ts` turns it into the steps that make the environment.
 * A project majhi cannot read an install from (Poetry or Pipenv only, no manifest) has no plan, and its task
 * starts as before.
 */

/** A repo's files plus a digest of any file, so a lock file too big to read still names the environment. */
export interface PlanFiles extends RepoFiles {
  /** The SHA-256 of a file's bytes, or undefined when it is missing, not a plain file or outside the repo. */
  digest(rel: string): Promise<string | undefined>;
}

/** One part of an install, run in order into the same environment. */
export type PythonInstall =
  /** The flattened requirements (includes followed, local paths and options left out) and constraints. */
  | { kind: "pip"; requirements: string; constraints: string; skipped: string[] }
  /** The dependencies of `pyproject.toml` (not the project itself), with the extras the CI file asks for. */
  | { kind: "pyproject"; extras: string[] }
  /** `uv sync --frozen` of a project with a `uv.lock`, without installing the project itself. */
  | { kind: "uv-sync" };

export interface PythonPlan {
  ecosystem: "python";
  /** The folder of the project's Python files, relative to the repo root. Empty: the root. */
  dir: string;
  installs: PythonInstall[];
  /** `3.12` or `3.12.4` from `.python-version`; absent: the runner's own Python. */
  python?: string | undefined;
  /** Debian packages the build needs: the CI file's `apt-get install` lines and the table of known needs. */
  system: string[];
  /** Digests of the files that decide what is installed and are not in `installs` (a lock file). */
  digests: Record<string, string>;
  /** Where the install came from, for the owner: "the install step of .github/workflows/ci.yml job test". */
  from: string;
}

/** Python's own manifests, in the order that says a folder is a Python project. */
const MANIFESTS = [
  "requirements.txt",
  "pyproject.toml",
  "uv.lock",
  "setup.py",
  "setup.cfg",
  "Pipfile",
] as const;
/** Requirements files of a development setup that sit next to `requirements.txt`. */
const EXTRA_REQUIREMENTS = [
  "requirements-dev.txt",
  "requirements-test.txt",
  "requirements_dev.txt",
  "requirements_test.txt",
  "dev-requirements.txt",
  "test-requirements.txt",
] as const;
/** Folders a scan for a Python project does not enter. */
const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "vendor",
  "venv",
  "env",
  "docs",
  "doc",
  "tests",
  "test",
  "dist",
  "build",
  "site-packages",
]);
const MAX_FOLDERS = 30;
const MAX_DEPTH = 6;
const MAX_LINES = 5_000;

const at = (dir: string, name: string): string => (dir === "" ? name : posix.join(dir, name));

/** A command's folder as a repo-relative path: none, `.` and `./` are the root. */
function dirOf(workdir: string | undefined): string | undefined {
  if (workdir === undefined) return "";
  const clean = posix.normalize(workdir);
  const trimmed = clean === "." || clean === "./" ? "" : clean.endsWith("/") ? clean.slice(0, -1) : clean;
  return trimmed === ".." || trimmed.startsWith("../") || trimmed.startsWith("/") ? undefined : trimmed;
}

// ---------------------------------------------------------------------------
// pip install lines

export interface PipArgs {
  requirements: string[];
  constraints: string[];
  /** Named packages (`pytest`, `coverage>=7`). */
  packages: string[];
  /** `.` or `-e .`: the project itself, and the extras asked for. Not installed into a shared environment. */
  self: boolean;
  extras: string[];
}

/** pip options that take a value as the next word. */
const VALUED: ReadonlySet<string> = new Set([
  "-i",
  "--index-url",
  "--extra-index-url",
  "-f",
  "--find-links",
  "-t",
  "--target",
  "--prefix",
  "--root",
  "--python",
  "--platform",
  "--implementation",
  "--abi",
  "--only-binary",
  "--no-binary",
  "--src",
  "--cache-dir",
  "--log",
  "--proxy",
  "--retries",
  "--timeout",
  "--exists-action",
  "--trusted-host",
  "--cert",
  "--client-cert",
  "--progress-bar",
  "--python-version",
  "--upgrade-strategy",
  "--global-option",
  "--config-settings",
  "-C",
  "--use-feature",
  "--use-deprecated",
  "--group",
  "--extra",
]);

/** The words after `pip install` of a line that is one, whatever runs pip: `pip`, `python -m pip`, `uv pip`. */
function afterPipInstall(argv: readonly string[]): string[] | undefined {
  let words = argv[0] === "sudo" ? argv.slice(1) : argv;
  const first = words[0] ?? "";
  const program = first.slice(first.lastIndexOf("/") + 1);
  const isPython = program === "python" || program === "python3" || program.startsWith("python3.");
  if (program === "pip" || program === "pip3" || program.startsWith("pip3.")) words = words.slice(1);
  else if (isPython && words[1] === "-m" && words[2] === "pip") words = words.slice(3);
  else if (program === "uv" && words[1] === "pip") words = words.slice(2);
  else return undefined;
  return words[0] === "install" ? words.slice(1) : undefined;
}

/** `.[dev,test]` or `-e .[dev]`: the extras between the brackets, or none. */
function extrasOf(spec: string): string[] | undefined {
  if (spec !== "." && !spec.startsWith(".[")) return undefined;
  if (spec === ".") return [];
  const close = spec.indexOf("]");
  if (close < 0) return [];
  return spec
    .slice(2, close)
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e !== "");
}

/**
 * The install a `pip install` line makes, or undefined when the line is not one, or names a value only the
 * CI knows (`$VAR`). Local paths and wheels are left out: they are not part of a shared environment.
 */
export function pipInstallArgs(argv: readonly string[]): PipArgs | undefined {
  const words = afterPipInstall(argv);
  if (words === undefined || words.some((w) => w.includes("$"))) return undefined;
  const out: PipArgs = { requirements: [], constraints: [], packages: [], self: false, extras: [] };
  const own = (extras: string[] | undefined) => {
    if (extras === undefined) return;
    out.self = true;
    out.extras.push(...extras);
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    const req = optionValue(words, i, "-r", "--requirement");
    const con = optionValue(words, i, "-c", "--constraint");
    const edit = optionValue(words, i, "-e", "--editable");
    if (req !== undefined) {
      if (req.value !== undefined) out.requirements.push(req.value);
      i = req.at;
    } else if (con !== undefined) {
      if (con.value !== undefined) out.constraints.push(con.value);
      i = con.at;
    } else if (edit !== undefined) {
      own(edit.value === undefined ? undefined : extrasOf(edit.value));
      i = edit.at;
    } else if (w.startsWith("-")) {
      if (VALUED.has(w)) i++;
    } else if (extrasOf(w) !== undefined) {
      own(extrasOf(w));
    } else if (!isPath(w)) {
      out.packages.push(w);
    }
  }
  return out;
}

/** An option's value in any of its spellings (`-r x`, `-rx`, `--requirement x`, `--requirement=x`), and the index of the last word it used. */
function optionValue(
  words: readonly string[],
  i: number,
  short: string,
  long: string,
): { value: string | undefined; at: number } | undefined {
  const w = words[i] ?? "";
  if (w === short || w === long) return { value: words[i + 1], at: i + 1 };
  if (w.startsWith(`${long}=`)) return { value: w.slice(long.length + 1), at: i };
  if (w.startsWith(short) && !w.startsWith("--")) return { value: w.slice(short.length), at: i };
  return undefined;
}

/** A word that names a file or a place, not a package: it is not part of a shared environment. */
const isPath = (w: string): boolean =>
  w.startsWith(".") || w.startsWith("/") || w.includes("://") || w.endsWith(".whl") || w.endsWith(".tar.gz");

// ---------------------------------------------------------------------------
// Requirements files

interface Flat {
  lines: string[];
  skipped: string[];
  seen: Set<string>;
}

/** A requirements file's logical lines: a trailing backslash joins the next, comments and blanks are gone. */
function logicalLines(text: string): string[] {
  const out: string[] = [];
  let carry = "";
  for (const raw of text.split("\n").slice(0, MAX_LINES)) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.endsWith("\\")) {
      carry += `${line.slice(0, -1)} `;
      continue;
    }
    const whole = `${carry}${line}`.trim();
    carry = "";
    if (whole === "" || whole.startsWith("#")) continue;
    const comment = whole.indexOf(" #");
    out.push((comment < 0 ? whole : whole.slice(0, comment)).trim());
  }
  return out;
}

/** The file an `-r`/`-c` line names (`-r x`, `-rx`, `--requirement x`, `--requirement=x`), or undefined. */
function includeOf(line: string, short: string, long: string): string | undefined {
  if (line.startsWith(`${long}=`)) return line.slice(long.length + 1).trim();
  if (line.startsWith(`${long} `)) return line.slice(long.length + 1).trim();
  if (line.startsWith(short) && !line.startsWith("--")) return line.slice(short.length).trim();
  return undefined;
}

/**
 * Adds the lines of a requirements file, and of the files it includes, to `into`. `-r` and `-c` follow
 * inside the repo only. Options (`-e`, `--index-url`, `--hash` lines) and local paths are left out and
 * named in `skipped`: they would point the environment at a folder or an index of one checkout.
 */
async function flatten(
  files: PlanFiles,
  path: string,
  into: Flat,
  constraints: Flat,
  depth: number,
): Promise<boolean> {
  if (into.seen.has(path) || depth > MAX_DEPTH) return true;
  into.seen.add(path);
  const text = await files.read(path);
  if (text === undefined) return false;
  const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
  for (const line of logicalLines(text)) {
    const req = includeOf(line, "-r", "--requirement");
    const con = includeOf(line, "-c", "--constraint");
    const target = req ?? con;
    if (target !== undefined) {
      const resolved = resolveInRepo(dir, target);
      if (resolved === undefined) into.skipped.push(line);
      else await flatten(files, resolved, req === undefined ? constraints : into, constraints, depth + 1);
      continue;
    }
    if (line.startsWith("-") || line.startsWith(".") || line.startsWith("/") || line.startsWith("file:")) {
      into.skipped.push(line.length > 80 ? `${line.slice(0, 79)}…` : line);
      continue;
    }
    into.lines.push(line);
  }
  return true;
}

/** The flattened install of requirements files (repo-relative) and extra named packages. Undefined when none can be read. */
async function pipInstall(
  files: PlanFiles,
  requirementFiles: readonly string[],
  constraintFiles: readonly string[],
  packages: readonly string[],
): Promise<Extract<PythonInstall, { kind: "pip" }> | undefined> {
  const reqs: Flat = { lines: [], skipped: [], seen: new Set() };
  const cons: Flat = { lines: [], skipped: [], seen: new Set() };
  for (const file of requirementFiles) if (!(await flatten(files, file, reqs, cons, 0))) return undefined;
  for (const file of constraintFiles) await flatten(files, file, cons, cons, 0);
  reqs.lines.push(...packages);
  if (reqs.lines.length === 0) return undefined;
  const text = (f: Flat) => (f.lines.length === 0 ? "" : `${f.lines.join("\n")}\n`);
  return {
    kind: "pip",
    requirements: text(reqs),
    constraints: text(cons),
    skipped: [...reqs.skipped, ...cons.skipped],
  };
}

// ---------------------------------------------------------------------------
// pyproject.toml

interface Pyproject {
  names: string[];
  extraNames: Record<string, string[]>;
}

async function readPyproject(files: PlanFiles, dir: string): Promise<Pyproject | undefined> {
  const text = await files.read(at(dir, "pyproject.toml"));
  if (text === undefined) return undefined;
  try {
    const data: unknown = parseToml(text);
    const project = (data as { project?: { dependencies?: unknown; "optional-dependencies"?: unknown } })
      .project;
    const deps = Array.isArray(project?.dependencies) ? project.dependencies : [];
    const names = deps.filter((d): d is string => typeof d === "string").map(pythonName);
    const optional = project?.["optional-dependencies"];
    const extraNames: Record<string, string[]> = {};
    if (typeof optional === "object" && optional !== null) {
      for (const [extra, list] of Object.entries(optional)) {
        if (Array.isArray(list))
          extraNames[extra] = list.filter((d): d is string => typeof d === "string").map(pythonName);
      }
    }
    return { names, extraNames };
  } catch {
    return undefined;
  }
}

/** `3.12` or `3.12.4`: digits and dots only, so it can go on a command line. */
function versionSpec(text: string | undefined): string | undefined {
  const first = text?.split("\n")[0]?.trim() ?? "";
  if (first.length === 0 || first.length > 12 || !first.startsWith("3.")) return undefined;
  return [...first].every((c) => (c >= "0" && c <= "9") || c === ".") && !first.endsWith(".")
    ? first
    : undefined;
}

// ---------------------------------------------------------------------------
// The plan

/** What the caller knows of the project's CI and card. */
export interface PythonHints {
  /** Every command of the repo's CI jobs. */
  commands: readonly CiCommand[];
  /** The project card's install command, when it has one. */
  installLine?: string | undefined;
  /** Folders (repo-relative) the project's checks run in, first the test check's. */
  checkDirs: readonly string[];
  /** Parses a shell line into its words, so the card's install line reads like a CI line. */
  words: (line: string) => string[][];
}

/** The `apt-get install` packages of the CI's commands, valid names only. */
function aptPackages(commands: readonly CiCommand[]): string[] {
  const out = new Set<string>();
  for (const { argv } of commands) {
    const words = argv[0] === "sudo" ? argv.slice(1) : argv;
    const program = words[0] ?? "";
    if ((program !== "apt-get" && program !== "apt") || !words.slice(1).includes("install")) continue;
    for (const w of words.slice(words.indexOf("install") + 1)) {
      if (!w.startsWith("-") && isDebianPackage(w)) out.add(w);
    }
  }
  return [...out].sort().slice(0, 30);
}

async function candidateDirs(files: PlanFiles, hints: PythonHints): Promise<string[]> {
  const dirs: string[] = [];
  const add = (d: string | undefined) => {
    if (d !== undefined && !dirs.includes(d)) dirs.push(d);
  };
  for (const d of hints.checkDirs) add(d);
  for (const c of hints.commands) if (pipInstallArgs(c.argv) !== undefined) add(dirOf(c.workdir));
  add("");
  const entries = await files.list("");
  for (const e of entries.slice(0, 200)) {
    if (e.dir && !e.name.startsWith(".") && !SKIPPED_DIRS.has(e.name) && dirs.length < MAX_FOLDERS)
      add(e.name);
  }
  return dirs;
}

async function hasManifest(files: PlanFiles, dir: string): Promise<boolean> {
  for (const m of MANIFESTS) if ((await files.digest(at(dir, m))) !== undefined) return true;
  return false;
}

/** The environment a Python project needs, or undefined when it has no Python project or majhi cannot read how it installs. */
export async function planPython(files: PlanFiles, hints: PythonHints): Promise<PythonPlan | undefined> {
  let dir: string | undefined;
  for (const candidate of await candidateDirs(files, hints)) {
    if (await hasManifest(files, candidate)) {
      dir = candidate;
      break;
    }
  }
  if (dir === undefined) return undefined;
  const here = dir;

  // The install the project itself runs: the CI file's, else the card's.
  const lines: { args: PipArgs; from: string }[] = [];
  for (const c of hints.commands) {
    const args = pipInstallArgs(c.argv);
    if (args !== undefined && dirOf(c.workdir) === here)
      lines.push({ args, from: `the install step of ${c.from.replace(/^from /, "")}` });
  }
  if (hints.installLine !== undefined) {
    for (const words of hints.words(hints.installLine)) {
      const args = pipInstallArgs(words);
      if (args !== undefined) lines.push({ args, from: "the project card's install command" });
    }
  }
  const pyproject = await readPyproject(files, here);
  const installs: PythonInstall[] = [];
  let from = "";
  const requirementFiles: string[] = [];
  const constraintFiles: string[] = [];
  const packages: string[] = [];
  const extras: string[] = [];
  let self = false;
  for (const l of lines) {
    for (const r of l.args.requirements) {
      const resolved = resolveInRepo(here, r);
      if (resolved !== undefined && !requirementFiles.includes(resolved)) requirementFiles.push(resolved);
    }
    for (const c of l.args.constraints) {
      const resolved = resolveInRepo(here, c);
      if (resolved !== undefined && !constraintFiles.includes(resolved)) constraintFiles.push(resolved);
    }
    packages.push(...l.args.packages);
    extras.push(...l.args.extras);
    self ||= l.args.self;
    from ||= l.from;
  }
  const digests: Record<string, string> = {};
  const lock = await files.digest(at(here, "uv.lock"));
  if (requirementFiles.length > 0 || packages.length > 0) {
    const pip = await pipInstall(files, requirementFiles, constraintFiles, packages);
    if (pip !== undefined) installs.push(pip);
  }
  if (
    self &&
    pyproject !== undefined &&
    pyproject.names.length + Object.keys(pyproject.extraNames).length > 0
  ) {
    installs.push({ kind: "pyproject", extras: [...new Set(extras)].sort() });
    from ||= "pyproject.toml";
  }
  if (installs.length === 0) {
    // No install line said what to install: the project's own files do.
    if (lock !== undefined && pyproject !== undefined) {
      installs.push({ kind: "uv-sync" });
      from = "uv.lock";
    } else {
      const found = [at(here, "requirements.txt")];
      for (const name of EXTRA_REQUIREMENTS) found.push(at(here, name));
      const existing: string[] = [];
      for (const f of found) if ((await files.digest(f)) !== undefined) existing.push(f);
      const pip = existing.length === 0 ? undefined : await pipInstall(files, existing, [], []);
      if (pip !== undefined) {
        installs.push(pip);
        from = existing.join(", ");
      } else if (pyproject !== undefined && pyproject.names.length > 0) {
        installs.push({ kind: "pyproject", extras: [] });
        from = "pyproject.toml";
      }
    }
  }
  if (installs.length === 0) return undefined;
  if (installs.some((i) => i.kind === "uv-sync")) {
    if (lock !== undefined) digests[at(here, "uv.lock")] = lock;
  }
  if (installs.some((i) => i.kind === "uv-sync" || i.kind === "pyproject")) {
    const toml = await files.digest(at(here, "pyproject.toml"));
    if (toml !== undefined) digests[at(here, "pyproject.toml")] = toml;
  }

  // Names for the table of known system needs: the flattened requirements and the pyproject's.
  const names = new Set<string>();
  for (const i of installs) {
    if (i.kind === "pip") for (const r of parseRequirements(i.requirements)) names.add(r.name);
    if (i.kind === "pyproject" && pyproject !== undefined) {
      for (const n of pyproject.names) names.add(n);
      for (const e of i.extras) for (const n of pyproject.extraNames[e] ?? []) names.add(n);
    }
  }
  const system = [...new Set([...aptPackages(hints.commands), ...systemFor(names)])].sort();
  const python =
    versionSpec(await files.read(at(here, ".python-version"))) ??
    versionSpec(await files.read(".python-version"));
  return { ecosystem: "python", dir: here, installs, python, system, digests, from };
}
