import { parse as parseToml } from "smol-toml";
import { type GitlabFile, readCiFiles, readYaml, type YamlFile } from "../../ci/read.ts";
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

export type { GitlabFile, YamlFile };

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

const MAX_DOCKERFILES = 15;
const MAX_MAKEFILES = 10;
const MAX_SCRIPTS = 20;
const MAX_DOCS = 12;
const MAX_CHARTS = 10;

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
  const ci = await readCiFiles(files);

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
    workflows: ci.workflows,
    gitlab: ci.gitlab,
    bitbucket: ci.bitbucket,
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
