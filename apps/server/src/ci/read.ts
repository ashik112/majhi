import { type Located, readLocated } from "../wiki/facts/located.ts";
import { joinPath, resolveInRepo } from "../wiki/facts/read.ts";

/**
 * The CI files of a repo, read once with a real YAML parser: GitHub Actions workflows, the GitLab
 * pipeline and its local includes, and Bitbucket Pipelines. The wiki's deploy facts and the project
 * card's checks both read them from here, so a file is parsed one way everywhere. A file that is
 * missing, too big or does not parse is left out.
 */

/** What a repo gives to be read: a file's text, and a folder's entries. */
export interface CiSource {
  read(rel: string): Promise<string | undefined>;
  list(rel: string): Promise<{ name: string; dir: boolean }[]>;
}

const MAX_WORKFLOWS = 40;
const MAX_GITLAB = 12;
const GITLAB_DEPTH = 3;

const isYaml = (path: string): boolean => path.endsWith(".yml") || path.endsWith(".yaml");

export interface YamlFile {
  path: string;
  located: Located;
}

/** A GitLab pipeline file: the root one or a local include. `unread` names includes that cannot be read here (another project, a template, a URL, a glob). */
export interface GitlabFile extends YamlFile {
  unread: string[];
}

export async function readYaml(files: Pick<CiSource, "read">, path: string): Promise<YamlFile | undefined> {
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
async function readGitlab(files: CiSource): Promise<GitlabFile[]> {
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

export interface CiFiles {
  workflows: YamlFile[];
  gitlab: GitlabFile[];
  bitbucket: YamlFile | undefined;
}

export async function readCiFiles(files: CiSource): Promise<CiFiles> {
  const names = (await files.list(".github/workflows"))
    .filter((e) => !e.dir && isYaml(e.name))
    .slice(0, MAX_WORKFLOWS);
  const workflows: YamlFile[] = [];
  for (const entry of names) {
    const file = await readYaml(files, joinPath(".github/workflows", entry.name));
    if (file !== undefined) workflows.push(file);
  }
  return {
    workflows,
    gitlab: await readGitlab(files),
    bitbucket: await readYaml(files, "bitbucket-pipelines.yml"),
  };
}
