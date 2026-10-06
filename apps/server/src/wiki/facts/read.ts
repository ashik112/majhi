import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { ProjectFiles } from "./files.ts";
import type { DotenvEntry, PythonRequirement } from "./formats.ts";
import { type Instruction, parseDockerfile, parseDotenv, parseRequirements } from "./formats.ts";
import { type Located, readAllLocated, readLocated } from "./located.ts";

/**
 * Everything the scanners read from one repo's export, once: the manifests and config files of every folder
 * (the root and every workspace member), parsed with their real parsers and checked with zod. The scanners read
 * this and never touch the disk.
 */

const Deps = z.record(z.string(), z.string()).optional().catch(undefined);

/** `package.json`, as much as the wiki needs. Anything else in the file is ignored. */
export const PackageSchema = z.looseObject({
  name: z.string().optional().catch(undefined),
  private: z.boolean().optional().catch(undefined),
  main: z.unknown().optional(),
  module: z.unknown().optional(),
  types: z.unknown().optional(),
  exports: z.unknown().optional(),
  bin: z.unknown().optional(),
  scripts: z.record(z.string(), z.unknown()).optional().catch(undefined),
  dependencies: Deps,
  optionalDependencies: Deps,
  peerDependencies: Deps,
  devDependencies: Deps,
});
export type PackageJson = z.infer<typeof PackageSchema>;

const Str = z.string();
/** `pyproject.toml`: PEP 621 and Poetry. */
export const PyprojectSchema = z.looseObject({
  project: z
    .looseObject({
      name: Str.optional().catch(undefined),
      dependencies: z.array(Str).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  "build-system": z.unknown().optional(),
  tool: z
    .looseObject({
      poetry: z
        .looseObject({
          name: Str.optional().catch(undefined),
          dependencies: z.record(Str, z.unknown()).optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type Pyproject = z.infer<typeof PyprojectSchema>;

/** One compose file's service, as much as the wiki needs. */
export const ComposeServiceSchema = z.looseObject({
  image: Str.optional().catch(undefined),
  build: z
    .union([
      Str,
      z.looseObject({
        context: Str.optional().catch(undefined),
        dockerfile: Str.optional().catch(undefined),
      }),
    ])
    .optional()
    .catch(undefined),
  command: z
    .union([Str, z.array(Str)])
    .optional()
    .catch(undefined),
  depends_on: z
    .union([z.array(Str), z.record(Str, z.unknown())])
    .optional()
    .catch(undefined),
  environment: z
    .union([z.array(Str), z.record(Str, z.union([Str, z.number(), z.boolean(), z.null()]))])
    .optional()
    .catch(undefined),
  ports: z
    .array(z.union([Str, z.number(), z.looseObject({})]))
    .optional()
    .catch(undefined),
  expose: z
    .array(z.union([Str, z.number()]))
    .optional()
    .catch(undefined),
});
export const ComposeSchema = z.looseObject({
  services: z.record(Str, ComposeServiceSchema).optional().catch(undefined),
});
export type Compose = z.infer<typeof ComposeSchema>;

/** A folder with a manifest: the repo root, an app, a package. Its dependencies tell what it is. */
export interface Member {
  /** Folder in the repo, `""` for the root. */
  dir: string;
  pkg?: { path: string; text: string; located: Located; data: PackageJson } | undefined;
  py?: { path: string; text: string; data: Pyproject } | undefined;
  requirements: { path: string; text: string; items: PythonRequirement[] }[];
  dockerfiles: { path: string; instructions: Instruction[] }[];
}

export interface ComposeFile {
  path: string;
  text: string;
  located: Located;
  data: Compose;
}

/** Kubernetes manifests (documents with `apiVersion` and `kind`) and Helm values, read as YAML documents. */
export interface KubeFile {
  path: string;
  text: string;
  docs: Located[];
  values: boolean;
}

export interface DotenvFile {
  path: string;
  text: string;
  entries: DotenvEntry[];
}

/** A file that says where a folder runs: `vercel.json`, `fly.toml`, `Procfile`. */
export interface Marker {
  path: string;
  dir: string;
  label: string;
  /** `vercel.json`, read as JSON: its `crons` are timers. */
  located?: Located | undefined;
}

export interface RepoScan {
  repo: string;
  files: ProjectFiles;
  /** Every file the walk saw, relative to the export. */
  paths: string[];
  members: Member[];
  compose: ComposeFile[];
  kube: KubeFile[];
  dotenv: DotenvFile[];
  markers: Marker[];
}

/** Files that name a host or platform. The value is what the unit says it runs on. */
export const DEPLOY_MARKERS: readonly (readonly [string, string])[] = [
  ["vercel.json", "Vercel"],
  ["netlify.toml", "Netlify"],
  ["fly.toml", "Fly.io"],
  ["render.yaml", "Render"],
  ["Procfile", "Heroku"],
  ["app.yaml", "App Engine"],
  ["serverless.yml", "Serverless"],
  ["wrangler.toml", "Cloudflare"],
  ["wrangler.json", "Cloudflare"],
  ["wrangler.jsonc", "Cloudflare"],
];

const ENV_NAMES: ReadonlySet<string> = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);
/** How far into the repo a manifest is looked for, and how many of each kind are read. */
const WALK = { maxDepth: 8, limit: 80_000 } as const;
const MAX_MEMBERS = 300;
const MAX_COMPOSE = 40;
const MAX_YAML = 400;
const MAX_DOTENV = 60;

export const dirOf = (path: string): string =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
export const joinPath = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

/** A compose file by name: any `*compose*.yml` or `.yaml` (`docker-compose.dev.yml`, `deploy/compose.prod.yaml`). */
export function isComposeName(base: string): boolean {
  const low = base.toLowerCase();
  return low.includes("compose") && (low.endsWith(".yml") || low.endsWith(".yaml"));
}

const isYamlName = (base: string): boolean => base.endsWith(".yaml") || base.endsWith(".yml");
const isRequirementsName = (base: string): boolean =>
  base.startsWith("requirements") && base.endsWith(".txt");
const isDockerfileName = (base: string): boolean =>
  base === "Dockerfile" || base.startsWith("Dockerfile.") || base.endsWith(".Dockerfile");

function isKubeDoc(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const doc = data as Record<string, unknown>;
  return typeof doc.apiVersion === "string" && typeof doc.kind === "string";
}

async function readMember(files: ProjectFiles, dir: string, names: readonly string[]): Promise<Member> {
  const member: Member = { dir, requirements: [], dockerfiles: [] };
  for (const name of names) {
    const path = joinPath(dir, name);
    const text = await files.read(path);
    if (text === undefined) continue;
    if (name === "package.json") {
      const located = readLocated(text);
      const parsed = located === undefined ? undefined : PackageSchema.safeParse(located.data);
      if (located !== undefined && parsed?.success) member.pkg = { path, text, located, data: parsed.data };
    } else if (name === "pyproject.toml") {
      try {
        const parsed = PyprojectSchema.safeParse(parseToml(text));
        if (parsed.success) member.py = { path, text, data: parsed.data };
      } catch {
        // A pyproject that does not parse adds nothing.
      }
    } else if (isRequirementsName(name)) {
      member.requirements.push({ path, text, items: parseRequirements(text) });
    } else if (isDockerfileName(name)) {
      member.dockerfiles.push({ path, instructions: parseDockerfile(text) });
    }
  }
  return member;
}

/**
 * Reads the repo's config files, wherever they are. A file that is missing, too big or does not parse is left out.
 * Compose files are found by name (any `*compose*.y*ml`), Kubernetes files by content (`apiVersion` and `kind`,
 * never by folder), and every folder with a manifest is a member.
 */
export async function readRepo(files: ProjectFiles, repo: string): Promise<RepoScan> {
  const { files: all } = await files.walk("", WALK);
  const sorted = all.toSorted();
  const byDir = new Map<string, string[]>();
  const chartDirs = new Set<string>();
  const scan: RepoScan = {
    repo,
    files,
    paths: sorted,
    members: [],
    compose: [],
    kube: [],
    dotenv: [],
    markers: [],
  };
  const markerNames = new Map(DEPLOY_MARKERS);
  let yaml = 0;

  for (const path of sorted) {
    const base = baseOf(path);
    const dir = dirOf(path);
    if (base === "Chart.yaml") chartDirs.add(dir);
    const manifest =
      base === "package.json" ||
      base === "pyproject.toml" ||
      isRequirementsName(base) ||
      isDockerfileName(base);
    if (manifest) byDir.set(dir, [...(byDir.get(dir) ?? []), base]);
    const label = markerNames.get(base);
    if (label !== undefined) {
      const text = base === "vercel.json" ? await files.read(path) : undefined;
      scan.markers.push({ path, dir, label, located: text === undefined ? undefined : readLocated(text) });
    }
  }

  for (const [dir, names] of [...byDir].slice(0, MAX_MEMBERS)) {
    // A folder with only a Dockerfile is not a member: its Dockerfile is read with the compose file that builds it.
    if (!names.some((n) => n === "package.json" || n === "pyproject.toml" || isRequirementsName(n))) continue;
    scan.members.push(await readMember(files, dir, names));
  }

  for (const path of sorted) {
    const base = baseOf(path);
    if (ENV_NAMES.has(base) && scan.dotenv.length < MAX_DOTENV) {
      const text = await files.read(path);
      if (text !== undefined) scan.dotenv.push({ path, text, entries: parseDotenv(text) });
      continue;
    }
    if (!isYamlName(base)) continue;
    if (!isComposeName(base)) {
      if (yaml >= MAX_YAML) continue;
      yaml += 1;
    }
    const text = await files.read(path);
    if (text === undefined) continue;
    if (isComposeName(base)) {
      if (scan.compose.length >= MAX_COMPOSE) continue;
      const located = readLocated(text);
      const parsed = located === undefined ? undefined : ComposeSchema.safeParse(located.data);
      if (located !== undefined && parsed?.success && parsed.data.services !== undefined) {
        scan.compose.push({ path, text, located, data: parsed.data });
      }
      continue;
    }
    const docs = readAllLocated(text);
    const values = base.startsWith("values") && chartDirs.has(dirOf(path));
    const manifests = values ? docs : docs.filter((d) => isKubeDoc(d.data));
    if (manifests.length > 0) scan.kube.push({ path, text, docs: manifests, values });
  }
  return scan;
}

/** The folder `target` names when it is read from `from`'s folder, or undefined when it leaves the repo. */
export function resolveInRepo(fromDir: string, target: string): string | undefined {
  if (target.startsWith("/")) return undefined;
  const out = posix.normalize(joinPath(fromDir, target));
  const clean = out === "." ? "" : out.endsWith("/") ? out.slice(0, -1) : out;
  return clean === ".." || clean.startsWith("../") ? undefined : clean;
}
