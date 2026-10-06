import type { MapEdge, MapEndpoint, MapNode } from "@majhi/shared";
import { git } from "../../git/git.ts";
import { Resolver } from "../system/resolver.ts";
import { MapBuilder } from "./builder.ts";
import { DEPLOY_MARKERS, type LoadCache, type Loaded, loadCached } from "./facts.ts";
import { finalImage } from "./formats.ts";
import { frameworkOf, roleOfDeps } from "./known.ts";
import { PRE_SCANS, PROJECT_SOURCES } from "./sources.ts";

/**
 * The config pass: plain code, no model. Reads each registered project's checkout (read-only) and turns
 * its manifests, compose files, Dockerfile, example environment files, Kubernetes files and git remotes
 * into project nodes, datastore and outside-service nodes, and lines with their file and line as proof.
 * The same checkouts always give the same map.
 */

export interface ProjectInput {
  id: string;
  /** The checkout, absolute. */
  path: string;
}

export interface ConfigResult {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Addresses the projects call that are not outside services nor datastores. Each is asked about until it has an owner. */
  endpoints: MapEndpoint[];
  /** Host names a compose file proves belong to exactly one project, for the code pass to resolve the same way. */
  services: Map<string, string>;
  /** What was read, for the code pass to pick files from. */
  loaded: Loaded[];
}

/** The URLs of a checkout's remotes (fetch side). A folder that is not a repo has none. */
export async function gitRemotes(path: string): Promise<string[]> {
  try {
    const out = await git(path, ["remote", "-v"], { timeoutMs: 5_000 });
    const urls: string[] = [];
    for (const line of out.split("\n")) {
      if (!line.endsWith("(fetch)")) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const url = line.slice(tab + 1, line.length - "(fetch)".length).trim();
      if (url !== "") urls.push(url);
    }
    return urls;
  } catch {
    return [];
  }
}

/** Where the project runs, from the files that say so. */
function deployOf(l: Loaded): string | undefined {
  for (const [file, label] of DEPLOY_MARKERS) if (l.markers.has(file)) return label;
  if (l.markers.has("kubernetes") || l.markers.has("helm")) return "Kubernetes";
  if (l.markers.has("compose") || l.markers.has("Dockerfile")) return "Docker";
  return undefined;
}

/** The first chip of a project card: its framework, else its language. */
function stackOf(l: Loaded): string {
  const python = l.pkg === undefined && (l.py !== undefined || l.requirements.length > 0);
  return frameworkOf(l.deps, python) ?? (l.pkg !== undefined ? "Node" : python ? "Python" : "Project");
}

/** The sub line of a project box: the repo, and the image its Dockerfile ends in. */
function subOf(l: Loaded): string {
  const image = l.dockerfile === undefined ? undefined : finalImage(l.dockerfile.instructions);
  return `repo ${l.facts.id}${image === undefined ? "" : ` · ${image}`}`;
}

export async function configPass(
  projects: readonly ProjectInput[],
  options: { remotes?: (path: string) => Promise<string[]>; cache?: LoadCache } = {},
): Promise<ConfigResult> {
  const remotes = options.remotes ?? gitRemotes;
  const loaded: Loaded[] = [];
  for (const p of projects) loaded.push(await loadCached(p, remotes, options.cache));
  const resolver = new Resolver(loaded.map((l) => l.facts));
  for (const pre of PRE_SCANS) pre(loaded, resolver);

  const b = new MapBuilder("config", "confirmed");
  for (const l of loaded) {
    b.node({
      id: l.facts.id,
      kind: "project",
      label: l.facts.id,
      sub: subOf(l),
      project: l.facts.id,
      ...(deployOf(l) === undefined ? {} : { deploy: deployOf(l) as string }),
    });
  }
  for (const l of loaded) b.chip(l.facts.id, "stack", stackOf(l));
  const ctx = { resolver, b };
  for (const l of loaded) for (const source of PROJECT_SOURCES) source.scan(l, ctx);
  b.finishStores();
  // A project the others use as a library, that runs nowhere itself, is a library box.
  const used = new Set(b.edges.filter((e) => e.type === "lib").map((e) => e.to));
  for (const l of loaded) {
    if (!used.has(l.facts.id) || l.facts.runnable || !l.facts.publishable) continue;
    b.retype(l.facts.id, "library");
    const python = l.pkg === undefined;
    b.node({
      id: l.facts.id,
      kind: "library",
      label: l.facts.id,
      deploy: python ? "PyPI package" : l.pkg?.data.private === true ? "internal package" : "npm package",
    });
  }
  const roleOf = new Map(
    loaded.map((l) => [l.facts.id, roleOfDeps(l.deps, Object.keys(l.pkg?.data.scripts ?? {}))] as const),
  );
  const nodes = b.nodes.map((n) => {
    const role = n.project === undefined ? undefined : roleOf.get(n.project);
    return role === undefined ? n : { ...n, role };
  });
  const services = new Map<string, string>();
  for (const l of loaded) {
    for (const name of l.facts.services) {
      const owner = resolver.ownerOfService(name);
      if (owner !== undefined) services.set(name, owner);
    }
  }
  return { nodes, edges: b.edges, endpoints: b.endpoints, services, loaded };
}
