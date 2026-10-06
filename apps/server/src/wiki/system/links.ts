import {
  type OwnerAnswer,
  type OwnerCallAnswer,
  WIKI_BASES,
  type WikiAnswer,
  type WikiFact,
  type WikiFactBasis,
  type WikiFactOf,
  type WikiQuestion,
  type WikiSource,
  type WikiSystemLink,
  type WikiSystemView,
  type WikiUnlinkedCall,
} from "@majhi/shared";
import { endpointId, isLoopbackHost } from "./address.ts";
import { placeAddress } from "./endpoints.ts";
import { matchRoute, type RouteRef, segmentsOf } from "./match.ts";
import { type ProjectServices, Resolver } from "./resolver.ts";

/**
 * How a workspace's projects connect (docs/design/wiki.md, step 2). Made from each project's facts and the owner's
 * answers, with no model, and only by exact matches, strongest first:
 *
 * 1. declared: `projects.<id>.links` in majhi.yaml;
 * 2. a compose service that exactly one project builds, and an address that names it;
 * 3. an environment URL that names a compose or Kubernetes service exactly one project defines;
 * 4. a client call (method and path) that fits exactly one route of another project;
 * 5. the owner's answer, for what none of the above placed.
 *
 * A link never leaves the projects it is given: the caller passes one workspace's projects only. Pure.
 */

export interface SystemProject {
  id: string;
  /** The facts of the commit the project was last read at. */
  facts: readonly WikiFact[];
  /** The projects it declares it depends on (`projects.<id>.links`). */
  declared: readonly string[];
}

export interface SystemInput {
  org: string;
  projects: readonly SystemProject[];
  answers: readonly WikiAnswer[];
  /** Projects of the workspace with no facts yet: nothing links to or from them. */
  missing?: readonly string[];
}

const STORE_ROLES: ReadonlySet<string> = new Set(["database", "cache", "queue"]);

/** Strongest first: the order of `WIKI_BASES`. */
const BASIS_RANK = new Map<string, number>(WIKI_BASES.map((b, i) => [b, i]));

const of = <K extends WikiFact["kind"]>(facts: readonly WikiFact[], kind: K): WikiFactOf<K>[] =>
  facts.filter((f): f is WikiFactOf<K> => f.kind === kind);

const sourcesOf = (f: { sources: readonly WikiSource[] }): WikiSource[] => [...f.sources];

function servicesOf(project: SystemProject): ProjectServices {
  const units = of(project.facts, "unit").filter((u) => !STORE_ROLES.has(u.role));
  return {
    id: project.id,
    builds: new Set(units.filter((u) => u.builds === true).map((u) => u.name.toLowerCase())),
    defines: new Set(units.map((u) => u.name.toLowerCase())),
  };
}

const routesOf = (project: SystemProject): RouteRef[] =>
  of(project.facts, "entry").flatMap((e) =>
    e.entry.type === "http"
      ? [{ project: project.id, fact: e, method: e.entry.method, segs: segmentsOf(e.entry.path) }]
      : [],
  );

const addressOf = (answers: readonly WikiAnswer[]): OwnerAnswer[] =>
  answers.flatMap((a) =>
    a.kind === "address" ? [{ host: a.host, port: a.port, scope: a.scope, to: a.to }] : [],
  );

const callAnswersOf = (answers: readonly WikiAnswer[]): OwnerCallAnswer[] =>
  answers.flatMap((a) =>
    a.kind === "call" ? [{ repo: a.repo, method: a.method, path: a.path, to: a.to }] : [],
  );

function address(host: string, port: number | undefined): string {
  return `${host}${port === undefined ? "" : `:${port}`}`;
}

export function buildSystem(input: SystemInput): WikiSystemView {
  const projects = [...input.projects].toSorted((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(projects.map((p) => p.id));
  const resolver = new Resolver(projects.map(servicesOf));
  const addresses = addressOf(input.answers);
  const callAnswers = callAnswersOf(input.answers);
  const routes = projects.flatMap(routesOf);
  const links = new Map<string, WikiSystemLink>();
  const unlinked: WikiUnlinkedCall[] = [];

  const add = (link: WikiSystemLink) => {
    if (!links.has(link.id)) links.set(link.id, link);
  };

  // 1. Declared in majhi.yaml.
  for (const p of projects) {
    for (const to of p.declared) {
      if (to === p.id || !ids.has(to)) continue;
      add({
        id: `${p.id}>${to}:declared`,
        type: "lib",
        basis: "declared",
        from: { project: p.id, sources: [] },
        to: { project: to, sources: [] },
        label: "depends on (majhi.yaml)",
      });
    }
  }

  const unitOf = (project: string, name: string): WikiFactOf<"unit"> | undefined => {
    const units = of(projects.find((p) => p.id === project)?.facts ?? [], "unit").filter(
      (u) => u.name.toLowerCase() === name.toLowerCase(),
    );
    return units.find((u) => u.builds === true) ?? units[0];
  };

  // 2, 3, 5. An address a project writes, and who it leads to.
  const unplaced = new Map<string, WikiQuestion>();
  for (const p of projects) {
    for (const e of of(p.facts, "endpoint")) {
      const placed = placeAddress(resolver, addresses, e, p.id);
      if (placed === undefined) {
        const id = endpointId(e.host, e.port, e.scope);
        const had = unplaced.get(id);
        unplaced.set(id, {
          host: e.host,
          ...(e.port === undefined ? {} : { port: e.port }),
          ...(e.scope === undefined ? {} : { scope: e.scope }),
          projects: [...new Set([...(had?.projects ?? []), p.id])],
          keys: [...new Set([...(had?.keys ?? []), ...e.keys])].slice(0, 24),
          sources: [...(had?.sources ?? []), ...sourcesOf(e)].slice(0, 12),
        });
        continue;
      }
      if (placed.kind !== "project" || !ids.has(placed.project) || placed.project === p.id) continue;
      const unit = placed.basis === "owner" ? undefined : unitOf(placed.project, e.host);
      add({
        id: `${p.id}>${placed.project}:${placed.basis}:${e.id}`,
        type: "http",
        basis: placed.basis,
        from: { project: p.id, fact: e.id, sources: sourcesOf(e) },
        to: {
          project: placed.project,
          ...(unit === undefined ? {} : { fact: unit.id }),
          sources: unit === undefined ? [] : sourcesOf(unit),
        },
        label: `${address(e.host, e.port)}${placed.basis === "owner" ? " (owner)" : " (service)"}`,
      });
    }
  }

  // 4. A call that fits one route. A call to an address that is placed is matched against that project's routes only.
  for (const p of projects) {
    const own = routes.filter((r) => r.project === p.id);
    const other = routes.filter((r) => r.project !== p.id);
    for (const c of of(p.facts, "call")) {
      const answer = callAnswers.find(
        (a) => a.repo === p.id && a.method === c.method && a.path === c.path,
      )?.to;
      if (answer?.kind === "outside" || answer?.kind === "ignore") continue;
      let pool = other;
      let aimed: string | undefined;
      if (c.host !== undefined) {
        const scope = isLoopbackHost(c.host) ? p.id : undefined;
        const placed = placeAddress(resolver, addresses, { host: c.host, port: c.port, scope }, p.id);
        if (placed?.kind === "outside" || placed?.kind === "ignore") continue;
        // An address nobody placed is a question for the owner, not an unlinked call.
        if (placed === undefined && scope === undefined) continue;
        if (placed?.kind === "project") {
          aimed = placed.project;
          pool = other.filter((r) => r.project === placed.project);
        }
      }
      const shape = { method: c.method, segs: segmentsOf(c.path) };
      // A call that one of the project's own routes answers is not between projects.
      if (aimed === undefined && matchRoute(shape, own).kind === "one") continue;
      const m = matchRoute(shape, pool);
      if (m.kind === "one") {
        add({
          id: `${p.id}>${m.route.project}:exact:${c.id}`,
          type: "http",
          basis: "exact",
          from: { project: p.id, fact: c.id, sources: sourcesOf(c) },
          to: { project: m.route.project, fact: m.route.fact.id, sources: sourcesOf(m.route.fact) },
          label: `${c.method} ${c.path}`,
        });
        continue;
      }
      if (answer?.kind === "project" && ids.has(answer.project) && answer.project !== p.id) {
        add({
          id: `${p.id}>${answer.project}:owner:${c.id}`,
          type: "http",
          basis: "owner",
          from: { project: p.id, fact: c.id, sources: sourcesOf(c) },
          to: { project: answer.project, sources: [] },
          label: `${c.method} ${c.path} (owner)`,
        });
        continue;
      }
      const source = c.sources[0];
      if (source === undefined) continue;
      unlinked.push({
        call: c.id,
        project: p.id,
        method: c.method,
        path: c.path,
        source,
        why: m.kind === "ambiguous" ? "ambiguous" : "no-route",
        matches: m.kind === "ambiguous" ? m.projects : [],
      });
    }
  }

  const ordered = [...links.values()].toSorted(
    (a, b) =>
      (BASIS_RANK.get(a.basis) ?? 9) - (BASIS_RANK.get(b.basis) ?? 9) ||
      a.from.project.localeCompare(b.from.project) ||
      a.to.project.localeCompare(b.to.project) ||
      a.label.localeCompare(b.label),
  );
  return {
    org: input.org,
    links: ordered,
    // With no other project read there is nothing to link to, so no call is "not linked" yet.
    unlinked: (projects.length < 2 ? [] : unlinked).toSorted(
      (a, b) =>
        a.project.localeCompare(b.project) ||
        a.source.path.localeCompare(b.source.path) ||
        a.source.lines[0] - b.source.lines[0],
    ),
    questions: [...unplaced.values()].toSorted(
      (a, b) => b.sources.length - a.sources.length || a.host.localeCompare(b.host),
    ),
    missing: [...(input.missing ?? [])].toSorted(),
  };
}

/** One edge per pair of projects and type, for a picture: its label names the strongest link and how many more there are. */
export interface PairLink {
  from: string;
  to: string;
  type: WikiSystemLink["type"];
  basis: WikiFactBasis;
  label: string;
  count: number;
}

export function pairLinks(links: readonly WikiSystemLink[]): PairLink[] {
  const out = new Map<string, PairLink>();
  for (const l of links) {
    const key = `${l.from.project}>${l.to.project}:${l.type}`;
    const had = out.get(key);
    if (had === undefined) {
      out.set(key, {
        from: l.from.project,
        to: l.to.project,
        type: l.type,
        basis: l.basis,
        label: l.label,
        count: 1,
      });
    } else {
      had.count += 1;
    }
  }
  return [...out.values()];
}
