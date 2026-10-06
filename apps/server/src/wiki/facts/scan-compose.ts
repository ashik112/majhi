import type { WikiKnownRole, WikiRole } from "@majhi/shared";
import { wordsOf } from "../system/resolver.ts";
import type { ScanContext } from "./context.ts";
import { roleOfImage, storeOfImage } from "./known.ts";
import type { Compose } from "./read.ts";
import { type ComposeFile, dirOf, resolveInRepo } from "./read.ts";
import { fromValue } from "./scan-env.ts";
import { addStore } from "./stores.ts";

/**
 * Compose files, any `*compose*.y*ml` anywhere in the repo: each service is a unit (what it runs, its ports, what it
 * waits for), a service that runs a datastore is a store, and the environment values that point services at each
 * other are links. Values are read for their host and name only.
 */

type Service = NonNullable<Compose["services"]>[string];

/**
 * The folders a service's code can be in, most specific first: the folder of the Dockerfile it names (a repo
 * root is often the build context of several services, each with its own `<app>/Dockerfile`), then the build context.
 */
function buildFolders(composeDir: string, svc: Service): string[] {
  const build = svc.build;
  if (build === undefined) return [];
  const context = resolveInRepo(composeDir, typeof build === "string" ? build : (build.context ?? "."));
  if (context === undefined) return [];
  const dockerfile = typeof build === "string" ? undefined : build.dockerfile;
  const own =
    dockerfile === undefined
      ? undefined
      : resolveInRepo(context, dirOf(dockerfile) === "" ? "." : dirOf(dockerfile));
  return own === undefined || own === context ? [context] : [own, context];
}

/** The container port of a published port entry: `8000`, `"8000:80"`, `"127.0.0.1:8000:80/tcp"`. */
function containerPort(entry: unknown): number | undefined {
  if (typeof entry === "number") return entry;
  if (typeof entry === "string") {
    const last = entry.split(":").at(-1) ?? "";
    const port = Number(last.split("/")[0]);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
  }
  if (typeof entry === "object" && entry !== null && "target" in entry) {
    const target = (entry as { target: unknown }).target;
    return typeof target === "number" && Number.isInteger(target) && target > 0 && target < 65536
      ? target
      : undefined;
  }
  return undefined;
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

/** Words of the words in a service's name and command that say it runs jobs, not requests. */
const WORKER_WORDS: ReadonlySet<string> = new Set([
  "worker",
  "workers",
  "celery",
  "beat",
  "dramatiq",
  "huey",
  "rq",
]);

/** What a compose service is: a datastore by its image, else a worker by its name or command, else what the folder it builds is. */
function roleOfService(ctx: ScanContext, name: string, svc: Service, folders: readonly string[]): WikiRole {
  const imageRole = svc.image === undefined ? undefined : roleOfImage(svc.image);
  if (imageRole !== undefined) return imageRole;
  const command = Array.isArray(svc.command) ? svc.command.join(" ") : (svc.command ?? "");
  if ([...wordsOf(name), ...wordsOf(command)].some((w) => WORKER_WORDS.has(w))) return "worker";
  for (const folder of folders) {
    const roles: readonly WikiKnownRole[] = ctx.rolesOf(folder);
    if (roles[0] !== undefined) return roles[0];
  }
  return "unknown";
}

function scanFile(ctx: ScanContext, file: ComposeFile): void {
  const { sink } = ctx;
  const composeDir = dirOf(file.path);
  const at = (path: (string | number)[]): [number, number] => {
    const line = file.located.lineOf(path) ?? 1;
    return [line, line];
  };
  for (const [name, svc] of Object.entries(file.data.services ?? {})) {
    const folders = buildFolders(composeDir, svc);
    const store = svc.image === undefined ? undefined : storeOfImage(svc.image);
    const needs = Array.isArray(svc.depends_on) ? svc.depends_on : Object.keys(svc.depends_on ?? {});
    const ports = [...(svc.ports ?? []), ...(svc.expose ?? [])]
      .map(containerPort)
      .filter((p): p is number => p !== undefined);
    const cites = [{ path: file.path, lines: at(["services", name]) }];
    if (svc.image !== undefined) cites.push({ path: file.path, lines: at(["services", name, "image"]) });
    if (needs.length > 0) cites.push({ path: file.path, lines: at(["services", name, "depends_on"]) });
    sink.add({
      kind: "unit",
      name,
      role: roleOfService(ctx, name, svc, folders),
      runsOn: "Docker",
      ...(svc.image === undefined ? {} : { image: svc.image }),
      ports: [...new Set(ports)],
      dependsOn: needs,
      ...(svc.build === undefined ? {} : { builds: true }),
      basis: "declared",
      slug: name,
      cites,
    });
    if (store !== undefined) {
      addStore(ctx, {
        store,
        unit: name,
        basis: "declared",
        cite: { path: file.path, lines: at(["services", name, "image"]) },
        where: name,
      });
    }
    for (const e of environment(svc)) {
      fromValue(ctx, {
        key: e.key,
        value: e.value,
        cite: { path: file.path, lines: at(["services", name, ...e.path]) },
        where: name,
        unit: name,
      });
    }
  }
}

export function scanCompose(ctx: ScanContext): void {
  for (const file of ctx.scan.compose) scanFile(ctx, file);
}
