import { parse as parseToml } from "smol-toml";
import { wordsOf } from "../system/resolver.ts";
import type { ProjectFiles } from "./files.ts";
import { type Instruction, parseDockerfile } from "./formats.ts";
import { type Located, readLocated } from "./located.ts";
import { baseOf, dirOf, isDockerfileName, joinPath, type RepoScan, resolveInRepo } from "./read.ts";

/**
 * The files that show how a repo is deployed, read once from the export with real parsers: CI workflows and
 * pipelines (their folders start with a dot, which the general walk skips, so they are read by name), host config,
 * Dockerfiles, Makefiles, deploy scripts and deploy documents. `scan-deploy.ts` turns them into facts. A file that is
 * missing, too big or does not parse is left out.
 */

export interface YamlFile {
  path: string;
  located: Located;
}

/** A GitLab pipeline file: the root one or a local include. `unread` names includes that cannot be read here (another project, a template, a URL, a glob). */
export interface GitlabFile extends YamlFile {
  unread: string[];
}

export interface TextFile {
  path: string;
  text: string;
}

export interface DockerFile {
  path: string;
  instructions: Instruction[];
}

/** A host's config file, parsed by its format. `data` is absent for a file that has no parser here (a Procfile is read from `text`). */
export interface PlatformFile {
  path: string;
  label: string;
  text: string;
  data: unknown;
  located: Located | undefined;
}

export interface DeployFiles {
  workflows: YamlFile[];
  gitlab: GitlabFile[];
  bitbucket: YamlFile | undefined;
  platforms: PlatformFile[];
  dockerfiles: DockerFile[];
  makefiles: TextFile[];
  scripts: TextFile[];
  docs: TextFile[];
  /** Chart.yaml files, with the chart's name when it has one. */
  charts: { path: string; name: string | undefined }[];
}

/** Words in the name of a document that show it is about deploying. */
export const DOC_WORDS: ReadonlySet<string> = new Set([
  "deploy",
  "deploys",
  "deployed",
  "deploying",
  "deployment",
  "deployments",
  "release",
  "releases",
  "releasing",
  "rollback",
  "runbook",
  "runbooks",
]);

/** Words in the name of a script that show it deploys or releases. */
export const SCRIPT_WORDS: ReadonlySet<string> = new Set([
  ...DOC_WORDS,
  "ship",
  "publish",
  "provision",
  "rollout",
  "promote",
]);

/** Words in a Makefile target that show it deploys, releases, migrates or pushes an image. */
export const TARGET_WORDS: ReadonlySet<string> = new Set([...SCRIPT_WORDS, "migrate", "migrations", "push"]);

/** A folder with one of these names holds the program's own code, not its deploy scripts. */
const CODE_FOLDERS: ReadonlySet<string> = new Set([
  "e2e",
  "src",
  "lib",
  "app",
  "apps",
  "packages",
  "pkg",
  "internal",
  "cmd",
]);

const MAX_WORKFLOWS = 40;
const MAX_GITLAB = 12;
const MAX_DOCKERFILES = 15;
const MAX_MAKEFILES = 10;
const MAX_SCRIPTS = 20;
const MAX_DOCS = 12;
const MAX_CHARTS = 10;
const GITLAB_DEPTH = 3;

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "rb",
  "ps1",
]);
const DOC_EXTENSIONS: ReadonlySet<string> = new Set(["md", "mdx", "rst", "txt"]);
/** A folder with one of these names holds deploy files whatever its files are called. */
const DEPLOY_FOLDERS: ReadonlySet<string> = new Set(["deploy", "deployment", "deployments", "runbooks"]);

const extOf = (path: string): string => {
  const base = baseOf(path);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
};

const isYaml = (path: string): boolean => extOf(path) === "yml" || extOf(path) === "yaml";

const isMakefile = (base: string): boolean =>
  base === "Makefile" || base === "makefile" || base === "GNUmakefile" || base.endsWith(".mk");

const isTest = (path: string): boolean =>
  wordsOf(path).some((w) => w === "test" || w === "tests" || w === "spec");

async function readYaml(files: ProjectFiles, path: string): Promise<YamlFile | undefined> {
  const text = await files.read(path);
  const located = text === undefined ? undefined : readLocated(text);
  return located === undefined ? undefined : { path, located };
}

/** The `include:` entries of a GitLab file: the local paths to read, and a name for each one that cannot be read. */
export function gitlabIncludes(data: unknown): { local: string[]; unread: string[] } {
  const out = { local: [] as string[], unread: [] as string[] };
  if (typeof data !== "object" || data === null || !("include" in data)) return out;
  const include = (data as { include: unknown }).include;
  const items = Array.isArray(include) ? include : [include];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.startsWith("http://") || item.startsWith("https://"))
        out.unread.push(`remote ${shorten(item)}`);
      else if (item.includes("*")) out.unread.push(`glob ${shorten(item)}`);
      else out.local.push(item);
    } else if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      const local = o.local;
      if (typeof local === "string" && !local.includes("*")) out.local.push(local);
      else if (typeof local === "string") out.unread.push(`glob ${shorten(local)}`);
      else if (typeof o.project === "string") {
        const file = typeof o.file === "string" ? `:${o.file}` : "";
        out.unread.push(`project ${shorten(o.project + file)}`);
      } else if (typeof o.template === "string") out.unread.push(`template ${shorten(o.template)}`);
      else if (typeof o.remote === "string") out.unread.push(`remote ${shorten(o.remote)}`);
    }
  }
  return out;
}

function shorten(text: string, max = 80): string {
  const flat = text.split("\n").join(" ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The root pipeline and the local files it includes, to a few levels. A file read twice is read once. */
async function readGitlab(files: ProjectFiles): Promise<GitlabFile[]> {
  const out: GitlabFile[] = [];
  const seen = new Set<string>();
  const queue: { path: string; depth: number }[] = [{ path: ".gitlab-ci.yml", depth: 0 }];
  for (let next = queue.shift(); next !== undefined && out.length < MAX_GITLAB; next = queue.shift()) {
    if (seen.has(next.path)) continue;
    seen.add(next.path);
    const file = await readYaml(files, next.path);
    if (file === undefined) continue;
    const { local, unread } = gitlabIncludes(file.located.data);
    out.push({ ...file, unread });
    if (next.depth >= GITLAB_DEPTH) continue;
    for (const target of local) {
      // A local include is a path from the repo root, with or without a leading slash.
      const path = resolveInRepo("", target.startsWith("/") ? target.slice(1) : target);
      if (path !== undefined) queue.push({ path, depth: next.depth + 1 });
    }
  }
  return out;
}

async function readPlatform(
  files: ProjectFiles,
  path: string,
  label: string,
): Promise<PlatformFile | undefined> {
  const text = await files.read(path);
  if (text === undefined) return undefined;
  const ext = extOf(path);
  let data: unknown;
  let located: Located | undefined;
  if (ext === "toml") {
    try {
      data = parseToml(text);
    } catch {
      data = undefined;
    }
  } else if (ext === "json" || ext === "jsonc" || ext === "yml" || ext === "yaml") {
    // A `.jsonc` file may have whole-line comments, which the parser would refuse.
    located =
      readLocated(text) ??
      readLocated(
        text
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("//"))
          .join("\n"),
      );
    data = located?.data;
  }
  // `app.yaml` is also what other tools name their objects: a Kubernetes or Argo object is not a host's config.
  if (label === "App Engine" && typeof data === "object" && data !== null && "apiVersion" in data)
    return undefined;
  return { path, label, text, data, located };
}

/** A script that deploys: in a deploy folder or named for deploying, and not inside the program's own source folders. */
function isScript(path: string): boolean {
  if (isTest(path)) return false;
  if (!SCRIPT_EXTENSIONS.has(extOf(path))) return false;
  const folders = dirOf(path).split("/");
  if (folders.some((f) => CODE_FOLDERS.has(f))) return false;
  return folders.some((f) => DEPLOY_FOLDERS.has(f)) || wordsOf(baseOf(path)).some((w) => SCRIPT_WORDS.has(w));
}

function isDoc(path: string): boolean {
  if (!DOC_EXTENSIONS.has(extOf(path))) return false;
  const folders = dirOf(path).split("/");
  return folders.some((f) => DEPLOY_FOLDERS.has(f)) || wordsOf(baseOf(path)).some((w) => DOC_WORDS.has(w));
}

async function readTexts(files: ProjectFiles, paths: readonly string[], max: number): Promise<TextFile[]> {
  const out: TextFile[] = [];
  for (const path of paths) {
    if (out.length >= max) break;
    const text = await files.read(path);
    if (text !== undefined) out.push({ path, text });
  }
  return out;
}

/** Reads the deploy files of a repo. `scan` gives the paths the walk saw and the host markers already found. */
export async function readDeploy(files: ProjectFiles, scan: RepoScan): Promise<DeployFiles> {
  const names = (await files.list(".github/workflows"))
    .filter((e) => !e.dir && isYaml(e.name))
    .slice(0, MAX_WORKFLOWS);
  const workflows: YamlFile[] = [];
  for (const entry of names) {
    const file = await readYaml(files, joinPath(".github/workflows", entry.name));
    if (file !== undefined) workflows.push(file);
  }

  const platforms: PlatformFile[] = [];
  for (const marker of scan.markers) {
    const file = await readPlatform(files, marker.path, marker.label);
    if (file !== undefined) platforms.push(file);
  }

  const dockerfilePaths = scan.paths.filter((p) => isDockerfileName(baseOf(p))).slice(0, MAX_DOCKERFILES);
  const dockerfiles: DockerFile[] = [];
  for (const path of dockerfilePaths) {
    const text = await files.read(path);
    if (text !== undefined) dockerfiles.push({ path, instructions: parseDockerfile(text) });
  }

  const charts: DeployFiles["charts"] = [];
  for (const path of scan.paths.filter((p) => baseOf(p) === "Chart.yaml").slice(0, MAX_CHARTS)) {
    const chart = await readYaml(files, path);
    const name = chart === undefined ? undefined : (chart.located.data as { name?: unknown } | null)?.name;
    charts.push({ path, name: typeof name === "string" ? name : undefined });
  }

  return {
    workflows,
    gitlab: await readGitlab(files),
    bitbucket: await readYaml(files, "bitbucket-pipelines.yml"),
    platforms,
    dockerfiles,
    makefiles: await readTexts(
      files,
      scan.paths.filter((p) => isMakefile(baseOf(p))),
      MAX_MAKEFILES,
    ),
    scripts: await readTexts(files, scan.paths.filter(isScript), MAX_SCRIPTS),
    docs: await readTexts(files, scan.paths.filter(isDoc), MAX_DOCS),
    charts,
  };
}
