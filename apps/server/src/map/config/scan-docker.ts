import { dirname, resolve } from "node:path";
import type { MapBuilder } from "./builder.ts";
import type { Compose, Loaded } from "./facts.ts";
import { storeOfImage } from "./known.ts";
import { lineContaining, lineText } from "./located.ts";
import type { Resolver } from "./resolver.ts";
import { envExcerpt, linkFromValue } from "./scan-env.ts";

/**
 * Compose files: which service is which project or datastore, what starts after what, and the
 * environment values that point services at each other.
 */

type Service = NonNullable<Compose["services"]>[string];

/** The build folder of a service, as written. */
function buildContext(svc: Service): string | undefined {
  const build = svc.build;
  if (build === undefined) return undefined;
  return typeof build === "string" ? build : build.context;
}

/** The container port of a published port entry: `8000`, `"8000:80"`, `"127.0.0.1:8000:80/tcp"`. */
function containerPort(entry: unknown): number | undefined {
  if (typeof entry === "number") return entry;
  if (typeof entry === "string") {
    const last = entry.split(":").at(-1) ?? "";
    const port = Number(last.split("/")[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  }
  return undefined;
}

/**
 * Tells each project which compose services build it and which ports they expose, across every project
 * of the workspace, before anything resolves a URL: a value pointing at `http://api:8000` means the
 * project the `api` service builds.
 */
export function bindServices(all: readonly Loaded[], resolver: Resolver): void {
  for (const loaded of all) {
    for (const c of loaded.compose) {
      const composeDir = resolve(loaded.facts.path, dirname(c.file));
      for (const [name, svc] of Object.entries(c.data.services ?? {})) {
        const context = buildContext(svc);
        if (context === undefined) continue;
        const target = resolver.byPath(resolve(composeDir, context));
        if (target === undefined) continue;
        target.services.add(name);
        for (const entry of [...(svc.ports ?? []), ...(svc.expose ?? [])]) {
          const port = containerPort(entry);
          if (port !== undefined && !target.ports.includes(port)) target.ports.push(port);
        }
      }
    }
  }
}

/** The environment of a service as entries with the path of each in the file. */
function environment(svc: Service): { key: string; value: string; path: (string | number)[] }[] {
  const env = svc.environment;
  if (env === undefined) return [];
  if (Array.isArray(env)) {
    return env.flatMap((item, i) => {
      const eq = item.indexOf("=");
      return eq <= 0 ? [] : [{ key: item.slice(0, eq), value: item.slice(eq + 1), path: ["environment", i] }];
    });
  }
  return Object.entries(env).flatMap(([key, value]) =>
    value === null || value === undefined ? [] : [{ key, value: String(value), path: ["environment", key] }],
  );
}

export function scanCompose(loaded: Loaded, ctx: { resolver: Resolver; b: MapBuilder }): void {
  const { resolver, b } = ctx;
  for (const c of loaded.compose) {
    const composeDir = resolve(loaded.facts.path, dirname(c.file));
    const services = c.data.services ?? {};
    const nodeOf = new Map<string, string>();
    for (const [name, svc] of Object.entries(services)) {
      const context = buildContext(svc);
      if (context !== undefined) {
        const target = resolver.byPath(resolve(composeDir, context));
        if (target !== undefined) nodeOf.set(name, target.id);
        continue;
      }
      const store = svc.image === undefined ? undefined : storeOfImage(svc.image);
      // A datastore the project's own compose file runs is part of that project: a chip on its card.
      if (store !== undefined) b.chip(loaded.facts.id, "stack", store.label);
    }
    const proofAt = (path: (string | number)[], fallback: string, excerpt?: string) => {
      const line = c.located.lineOf(path) ?? lineContaining(c.text, fallback) ?? 1;
      return { project: loaded.facts.id, file: c.file, line, excerpt: excerpt ?? lineText(c.text, line) };
    };
    for (const [name, svc] of Object.entries(services)) {
      const from = nodeOf.get(name);
      if (from === undefined) continue;
      const needs = Array.isArray(svc.depends_on) ? svc.depends_on : Object.keys(svc.depends_on ?? {});
      for (const dep of needs) {
        const to = nodeOf.get(dep);
        if (to === undefined || to === from) continue;
        const proof = proofAt(["services", name, "depends_on"], "depends_on");
        b.edge({ from, to, type: "deploy", label: "starts after", proof });
      }
      for (const e of environment(svc)) {
        linkFromValue({ resolver, b, self: from }, from, e.key, e.value, {
          ...proofAt(["services", name, ...e.path], e.key, envExcerpt(e.key, e.value)),
        });
      }
    }
  }
}
