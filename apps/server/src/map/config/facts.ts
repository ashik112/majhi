import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { ProjectFiles } from "../files.ts";
import type { DotenvEntry, PythonRequirement } from "./formats.ts";
import {
  exposedPorts,
  type Instruction,
  normalizePython,
  parseDockerfile,
  parseDotenv,
  parseRequirements,
} from "./formats.ts";
import { type Located, readAllLocated, readLocated } from "./located.ts";
import { type ProjectFacts, remoteKey, wordsOf } from "./resolver.ts";

/**
 * Everything the config pass reads from one project, once: the manifests and config files that exist,
 * parsed with their real parsers and checked with zod. The scanners read this and never touch the disk.
 */

const Deps = z.record(z.string(), z.string()).optional().catch(undefined);

/** `package.json`, as much as the map needs. Anything else in the file is ignored. */
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

/** One compose file's service, as much as the map needs. */
export const ComposeServiceSchema = z.looseObject({
  image: Str.optional().catch(undefined),
  build: z
    .union([Str, z.looseObject({ context: Str.optional().catch(undefined) })])
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

export interface Loaded {
  facts: ProjectFacts;
  files: ProjectFiles;
  pkg?: { text: string; located: Located; data: PackageJson } | undefined;
  py?: { text: string; data: Pyproject } | undefined;
  requirements: { file: string; text: string; items: PythonRequirement[] }[];
  dockerfile?: { text: string; instructions: Instruction[] } | undefined;
  compose: { file: string; text: string; located: Located; data: Compose }[];
  dotenv: { file: string; text: string; entries: DotenvEntry[] }[];
  /** Kubernetes manifests and Helm values, read as YAML documents. */
  kube: { file: string; text: string; docs: Located[]; values: boolean }[];
  /** Names of files that say where the project runs. */
  markers: Set<string>;
  /** Every dependency name of the project, for framework and store hints. */
  deps: Set<string>;
}

export const COMPOSE_NAMES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;
const COMPOSE_DIRS = ["", "deploy", "docker", "infra"] as const;
const ENV_NAMES = [".env.example", ".env.sample", ".env.template", ".env.dist"] as const;
const KUBE_DIRS = ["k8s", "kubernetes", "manifests", "deploy", "infra/k8s"] as const;
const HELM_VALUES = ["values.yaml", "chart/values.yaml", "helm/values.yaml"] as const;
/** Files that name a host or platform. The value is what the project node says it runs on. */
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
  ["kustomization.yaml", "Kubernetes"],
];

function join(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/** The files `loadProject` looks at: fixed names, plus the entries of the Kubernetes and chart folders. */
async function watched(files: ProjectFiles): Promise<string[]> {
  const out: string[] = ["package.json", "pyproject.toml", "requirements.txt", "Dockerfile", ".git/config"];
  for (const dir of COMPOSE_DIRS) for (const name of COMPOSE_NAMES) out.push(join(dir, name));
  out.push(...ENV_NAMES, ...HELM_VALUES, ...DEPLOY_MARKERS.map(([name]) => name));
  for (const dir of KUBE_DIRS) {
    for (const entry of await files.list(dir)) if (!entry.dir) out.push(join(dir, entry.name));
  }
  for (const chart of await files.list("charts")) if (chart.dir) out.push(`charts/${chart.name}/values.yaml`);
  return out;
}

/** What `loadProject` read, kept per checkout while none of the files it looks at has changed. */
export class LoadCache {
  private readonly kept = new Map<string, { signature: string; loaded: Loaded }>();

  get(path: string, signature: string): Loaded | undefined {
    const hit = this.kept.get(path);
    return hit?.signature === signature ? hit.loaded : undefined;
  }

  set(path: string, signature: string, loaded: Loaded): void {
    this.kept.set(path, { signature, loaded });
  }
}

/** A copy a pass can change (services and ports are filled in across projects) without touching the cached one. */
function fresh(loaded: Loaded): Loaded {
  return {
    ...loaded,
    facts: { ...loaded.facts, services: new Set(), ports: [...loaded.facts.ports] },
    deps: new Set(loaded.deps),
  };
}

/**
 * `loadProject`, skipped when none of the project's config files changed since the last read: a handful of
 * `stat` calls instead of parsing every file. The git remotes are part of the signature (`.git/config`).
 */
export async function loadCached(
  project: { id: string; path: string },
  remotes: (path: string) => Promise<string[]>,
  cache: LoadCache | undefined,
): Promise<Loaded> {
  if (cache === undefined) return loadProject(project, remotes);
  const probe = new ProjectFiles(project.path);
  const stamps = await Promise.all(
    (await watched(probe)).map(async (rel) => `${rel}=${await probe.stamp(rel)}`),
  );
  const signature = `${project.id}|${stamps.join("|")}`;
  const hit = cache.get(project.path, signature);
  if (hit !== undefined) return fresh(hit);
  const loaded = await loadProject(project, remotes);
  cache.set(project.path, signature, fresh(loaded));
  return loaded;
}

/** Reads the project's config files. A file that is missing, too big or does not parse is left out. */
export async function loadProject(
  project: { id: string; path: string },
  remotes: (path: string) => Promise<string[]>,
): Promise<Loaded> {
  const files = new ProjectFiles(project.path);
  const loaded: Loaded = {
    facts: {
      id: project.id,
      path: project.path,
      remotes: [],
      ports: [],
      services: new Set(),
      words: new Set(wordsOf(project.id)),
      runnable: false,
      publishable: false,
    },
    files,
    requirements: [],
    compose: [],
    dotenv: [],
    kube: [],
    markers: new Set(),
    deps: new Set(),
  };
  const { facts } = loaded;

  for (const url of await remotes(project.path)) {
    const key = remoteKey(url);
    if (key !== undefined && !facts.remotes.includes(key)) facts.remotes.push(key);
  }

  const pkgText = await files.read("package.json");
  const pkgLocated = pkgText === undefined ? undefined : readLocated(pkgText);
  if (pkgText !== undefined && pkgLocated !== undefined) {
    const parsed = PackageSchema.safeParse(pkgLocated.data);
    if (parsed.success) {
      loaded.pkg = { text: pkgText, located: pkgLocated, data: parsed.data };
      facts.packageName = parsed.data.name;
      for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
      ] as const) {
        for (const name of Object.keys(parsed.data[section] ?? {})) loaded.deps.add(name);
      }
      const start = parsed.data.scripts?.start;
      if (typeof start === "string") facts.runnable = true;
      facts.publishable = [parsed.data.main, parsed.data.module, parsed.data.types, parsed.data.exports].some(
        (v) => v !== undefined && v !== null,
      );
    }
  }

  const pyText = await files.read("pyproject.toml");
  if (pyText !== undefined) {
    try {
      const parsed = PyprojectSchema.safeParse(parseToml(pyText));
      if (parsed.success) {
        loaded.py = { text: pyText, data: parsed.data };
        const name = parsed.data.project?.name ?? parsed.data.tool?.poetry?.name;
        if (name !== undefined) facts.pythonName = normalizePython(name);
        if (parsed.data["build-system"] !== undefined && parsed.data["build-system"] !== null) {
          facts.publishable = true;
        }
      }
    } catch {
      // A pyproject that does not parse adds nothing.
    }
  }
  const reqText = await files.read("requirements.txt");
  if (reqText !== undefined) {
    loaded.requirements.push({ file: "requirements.txt", text: reqText, items: parseRequirements(reqText) });
  }

  const dockerText = await files.read("Dockerfile");
  if (dockerText !== undefined) {
    const instructions = parseDockerfile(dockerText);
    loaded.dockerfile = { text: dockerText, instructions };
    for (const p of exposedPorts(instructions)) if (!facts.ports.includes(p.port)) facts.ports.push(p.port);
    facts.runnable = true;
    loaded.markers.add("Dockerfile");
  }

  for (const dir of COMPOSE_DIRS) {
    for (const name of COMPOSE_NAMES) {
      const rel = join(dir, name);
      const text = await files.read(rel);
      if (text === undefined) continue;
      const located = readLocated(text);
      const parsed = located === undefined ? undefined : ComposeSchema.safeParse(located.data);
      if (located === undefined || parsed === undefined || !parsed.success) continue;
      loaded.compose.push({ file: rel, text, located, data: parsed.data });
      loaded.markers.add("compose");
      facts.runnable = true;
    }
  }

  for (const name of ENV_NAMES) {
    const text = await files.read(name);
    if (text !== undefined) loaded.dotenv.push({ file: name, text, entries: parseDotenv(text) });
  }

  for (const [name] of DEPLOY_MARKERS) {
    if (await files.exists(name)) {
      loaded.markers.add(name);
      facts.runnable = true;
    }
  }

  for (const dir of KUBE_DIRS) {
    for (const entry of await files.list(dir)) {
      if (entry.dir || !(entry.name.endsWith(".yaml") || entry.name.endsWith(".yml"))) continue;
      const rel = join(dir, entry.name);
      const text = await files.read(rel);
      if (text === undefined) continue;
      const docs = readAllLocated(text);
      if (docs.length > 0) {
        loaded.kube.push({ file: rel, text, docs, values: false });
        loaded.markers.add("kubernetes");
        facts.runnable = true;
      }
    }
  }
  const valuesFiles: string[] = [...HELM_VALUES];
  for (const chart of await files.list("charts"))
    if (chart.dir) valuesFiles.push(`charts/${chart.name}/values.yaml`);
  for (const rel of valuesFiles) {
    const text = await files.read(rel);
    if (text === undefined) continue;
    const docs = readAllLocated(text);
    if (docs.length > 0) {
      loaded.kube.push({ file: rel, text, docs, values: true });
      loaded.markers.add("helm");
      facts.runnable = true;
    }
  }
  return loaded;
}
