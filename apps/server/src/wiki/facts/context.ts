import type { WikiKnownRole } from "@majhi/shared";
import { depsOf } from "./deps.ts";
import type { Store } from "./known.ts";
import { storeOfImage, techsOfDep } from "./known.ts";
import { baseOf, type RepoScan } from "./read.ts";
import { type FactSink, slugOf } from "./sink.ts";

/** What a scanner needs besides the files: where to put facts, and what the other files of the repo already showed. */
export interface ScanContext {
  scan: RepoScan;
  sink: FactSink;
  /** The roles a member folder's dependencies show, in the order backend, frontend, worker, then the rest. */
  rolesOf(dir: string): readonly WikiKnownRole[];
  /** The one compose or Kubernetes unit that runs this kind of store, when there is exactly one. */
  unitFor(store: Store): string | undefined;
  /** Compose services by name, with the store their image runs, for a URL that names a service. */
  service(name: string): { store: Store | undefined } | undefined;
}

/** Roles that frameworks give. A development dependency can show these (a bundled app lists its framework as one). */
export const FRAMEWORK_ROLES: ReadonlySet<WikiKnownRole> = new Set(["frontend", "backend", "worker"]);

const ROLE_ORDER: readonly WikiKnownRole[] = ["backend", "frontend", "worker"];

/** A name as a word of an id: lower case, runs of other characters are one `-`. The root folder is `root`. */
export function kebab(text: string): string {
  let out = "";
  let dash = false;
  for (const ch of text.toLowerCase()) {
    const alnum = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9");
    if (alnum) {
      if (dash && out !== "") out += "-";
      dash = false;
      out += ch;
    } else dash = true;
  }
  return out === "" ? "root" : out;
}

export function buildContext(scan: RepoScan, sink: FactSink): ScanContext {
  const roles = new Map<string, WikiKnownRole[]>();
  for (const member of scan.members) {
    const found = new Set<WikiKnownRole>();
    for (const dep of depsOf(member)) {
      for (const t of techsOfDep(dep.name, dep.python)) {
        if (!dep.dev || FRAMEWORK_ROLES.has(t.role)) found.add(t.role);
      }
    }
    roles.set(member.dir, [
      ...ROLE_ORDER.filter((r) => found.has(r)),
      ...[...found].filter((r) => !ROLE_ORDER.includes(r)),
    ]);
  }

  const services = new Map<string, { store: Store | undefined }>();
  const storeUnits = new Map<string, Set<string>>();
  for (const file of scan.compose) {
    for (const [name, svc] of Object.entries(file.data.services ?? {})) {
      const store = svc.image === undefined ? undefined : storeOfImage(svc.image);
      services.set(name, { store });
      if (store !== undefined)
        storeUnits.set(store.slug, new Set([...(storeUnits.get(store.slug) ?? []), name]));
    }
  }
  return {
    scan,
    sink,
    rolesOf: (dir) => roles.get(dir) ?? [],
    unitFor: (store) => {
      const units = storeUnits.get(store.slug);
      return units?.size === 1 ? [...units][0] : undefined;
    },
    service: (name) => services.get(name),
  };
}

/** The id slug of a store: the engine, plus the unit that runs it when this repo deploys one. */
export function storeSlug(store: Store, unit: string | undefined): string {
  return unit === undefined ? store.slug : slugOf(`${store.slug}-${kebab(unit)}`);
}

/** The name of a folder as a unit or component: its last part, or the repo itself for the root. */
export function nameOfDir(dir: string, repo: string): string {
  return dir === "" ? repo : baseOf(dir);
}
