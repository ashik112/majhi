import { resolve } from "node:path";
import type { MapBuilder } from "./builder.ts";
import type { Loaded } from "./facts.ts";
import { normalizePython, pythonName } from "./formats.ts";
import { outsideOfNpm, outsideOfPython, storeOfNpm, storeOfPython } from "./known.ts";
import { lineContaining, lineText } from "./located.ts";
import type { ProjectFacts, Resolver } from "./resolver.ts";

/**
 * Dependencies. A dependency on another registered project (by package name, local path or git remote)
 * is a library line. A client library for a datastore or a service's SDK is a line to that store or
 * service. Dev dependencies are build tools, not links, so only runtime sections count.
 */

const RUNTIME_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const LOCAL_PREFIXES = ["file:", "link:", "portal:"] as const;

function libLabel(spec: string): string {
  if (spec.startsWith("workspace:")) return "uses (workspace)";
  if (LOCAL_PREFIXES.some((p) => spec.startsWith(p))) return "uses (local)";
  if (spec.startsWith("git") || spec.includes("github.com")) return "uses (git)";
  return `uses ${spec.length > 28 ? `${spec.slice(0, 27)}…` : spec}`;
}

/** The project a package.json dependency means: by name, by a local path spec, or by a git remote spec. */
function jsTarget(
  project: ProjectFacts,
  resolver: Resolver,
  name: string,
  spec: string,
): ProjectFacts | undefined {
  const byName = resolver.byPackage(name);
  if (byName !== undefined && byName.id !== project.id) return byName;
  const prefix = LOCAL_PREFIXES.find((p) => spec.startsWith(p));
  if (prefix !== undefined) {
    const hit = resolver.byPath(resolve(project.path, spec.slice(prefix.length)));
    if (hit !== undefined && hit.id !== project.id) return hit;
  }
  const byGit = resolver.byRemote(spec);
  return byGit !== undefined && byGit.id !== project.id ? byGit : undefined;
}

export function scanPackageJson(loaded: Loaded, ctx: { resolver: Resolver; b: MapBuilder }): void {
  const { pkg, facts } = loaded;
  if (pkg === undefined) return;
  const { b, resolver } = ctx;
  for (const section of RUNTIME_SECTIONS) {
    for (const [name, spec] of Object.entries(pkg.data[section] ?? {})) {
      const line = pkg.located.lineOf([section, name]) ?? lineContaining(pkg.text, `"${name}"`) ?? 1;
      const proof = { project: facts.id, file: "package.json", line, excerpt: lineText(pkg.text, line) };
      const target = jsTarget(facts, resolver, name, spec);
      if (target !== undefined) {
        b.edge({ from: facts.id, to: target.id, type: "lib", label: libLabel(spec), proof });
        continue;
      }
      const store = storeOfNpm(name);
      if (store !== undefined) b.storeRef({ project: facts.id, store: store.store, via: store.via, proof });
      const outside = outsideOfNpm(name);
      if (outside !== undefined) b.chip(facts.id, "uses", outside.label);
    }
  }
}

/** The names and lines of the Python dependencies of pyproject.toml, requirements.txt and their git URLs. */
function pythonDependencies(
  loaded: Loaded,
): { name: string; url?: string | undefined; file: string; text: string; line: number }[] {
  const out: { name: string; url?: string | undefined; file: string; text: string; line: number }[] = [];
  const py = loaded.py;
  if (py !== undefined) {
    const listed: string[] = [
      ...(py.data.project?.dependencies ?? []),
      ...Object.keys(py.data.tool?.poetry?.dependencies ?? {}).filter((n) => n.toLowerCase() !== "python"),
    ];
    for (const raw of listed) {
      const name = pythonName(raw);
      const at = raw.indexOf(" @ ");
      const url = at > 0 ? raw.slice(at + 3).trim() : undefined;
      out.push({
        name,
        url,
        file: "pyproject.toml",
        text: py.text,
        line: lineContaining(py.text, raw) ?? 1,
      });
    }
  }
  for (const r of loaded.requirements) {
    for (const item of r.items) {
      out.push({ name: item.name, url: item.url, file: r.file, text: r.text, line: item.line });
    }
  }
  return out;
}

export function scanPython(loaded: Loaded, ctx: { resolver: Resolver; b: MapBuilder }): void {
  const { facts } = loaded;
  const { b, resolver } = ctx;
  for (const dep of pythonDependencies(loaded)) {
    if (dep.name === "") continue;
    loaded.deps.add(dep.name);
    const proof = {
      project: facts.id,
      file: dep.file,
      line: dep.line,
      excerpt: lineText(dep.text, dep.line),
    };
    const byName = resolver.byPython(normalizePython(dep.name));
    const target = byName ?? (dep.url === undefined ? undefined : resolver.byRemote(dep.url));
    if (target !== undefined && target.id !== facts.id) {
      b.edge({
        from: facts.id,
        to: target.id,
        type: "lib",
        label: dep.url === undefined ? "uses" : "uses (git)",
        proof,
      });
      continue;
    }
    const store = storeOfPython(dep.name);
    if (store !== undefined) b.storeRef({ project: facts.id, store: store.store, via: store.via, proof });
    const outside = outsideOfPython(dep.name);
    if (outside !== undefined) b.chip(facts.id, "uses", outside.label);
  }
}
