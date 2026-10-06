import {
  edgeId,
  endpointId,
  type MapAnswer,
  type MapConfidence,
  type MapEdge,
  type MapEndpoint,
  type MapEndpointRef,
  type MapResolution,
} from "@majhi/shared";

/**
 * Addresses and the lines they make. Pure.
 *
 * A project-to-project line exists only when an address a project calls is proven to belong to another
 * project: a compose file builds a service of that name (`known`, tier extracted), or the owner said so
 * (a resolution, tier inferred). A host name, a domain, a port or the words of a variable never decide.
 * An address nobody has an answer for stays an endpoint, and the page asks the owner about it.
 */

const REFS_MAX = 12;

/** `host` or `host:port` as typed, parsed with the URL parser. Undefined when it is anything else. */
export function parseAddress(text: string): { host: string; port: number | undefined } | undefined {
  let url: URL;
  try {
    url = new URL(`http://${text.trim()}`);
  } catch {
    return undefined;
  }
  const clean = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
  if (!clean || url.hostname === "") return undefined;
  return { host: url.hostname.toLowerCase(), port: url.port === "" ? undefined : Number(url.port) };
}

/** The owner's answer for an address, if any. */
export function answerOf(
  resolutions: readonly MapResolution[],
  e: Pick<MapEndpoint, "host" | "port" | "scope">,
): MapAnswer | undefined {
  const id = endpointId(e.host, e.port, e.scope);
  return resolutions.find((r) => endpointId(r.host, r.port, r.scope) === id)?.to;
}

/** The project that owns an address, and how that is known. */
export function ownerOf(
  resolutions: readonly MapResolution[],
  e: MapEndpoint,
): { project: string; confidence: MapConfidence } | undefined {
  if (e.known !== undefined) return { project: e.known, confidence: "extracted" };
  const answer = answerOf(resolutions, e);
  return answer?.kind === "project" ? { project: answer.project, confidence: "inferred" } : undefined;
}

/** Addresses nobody has said anything about, most called first. */
export function unanswered(map: {
  endpoints: readonly MapEndpoint[];
  resolutions: readonly MapResolution[];
}): MapEndpoint[] {
  return map.endpoints
    .filter((e) => e.known === undefined && answerOf(map.resolutions, e) === undefined)
    .toSorted((a, b) => b.refs.length - a.refs.length || a.id.localeCompare(b.id));
}

function addRefs(into: MapEndpointRef[], more: readonly MapEndpointRef[]): MapEndpointRef[] {
  const out = [...into];
  for (const r of more) {
    if (out.length >= REFS_MAX) break;
    if (!out.some((q) => q.project === r.project && q.file === r.file && q.line === r.line)) out.push(r);
  }
  return out;
}

/**
 * The addresses of one update. Config refs are made again every update. Refs the model found stay until the
 * model reads that project again (then its old ones go); refs of a project that is gone go too.
 */
export function mergeEndpoints(input: {
  config: readonly MapEndpoint[];
  previous: readonly MapEndpoint[];
  found: readonly MapEndpoint[];
  /** Projects the model read this time: what it found earlier in them is replaced by `found`. */
  reread: ReadonlySet<string>;
  /** Projects whose code graph was read this time: their earlier `graph` refs are replaced by `config`'s. */
  graphRead?: ReadonlySet<string>;
  projects: ReadonlySet<string>;
  /** Host names a compose file proves belong to one project. */
  services: ReadonlyMap<string, string>;
}): MapEndpoint[] {
  const out = new Map<string, MapEndpoint>();
  const add = (e: MapEndpoint, refs: readonly MapEndpointRef[]) => {
    if (refs.length === 0) return;
    const had = out.get(e.id);
    const known = e.known ?? (e.scope === undefined ? input.services.get(e.host) : undefined);
    if (had === undefined) {
      out.set(e.id, { ...e, ...(known === undefined ? {} : { known }), refs: addRefs([], refs) });
    } else {
      out.set(e.id, {
        ...had,
        ...(had.known === undefined && known !== undefined ? { known } : {}),
        refs: addRefs(had.refs, refs),
      });
    }
  };
  for (const e of input.config) add(e, e.refs);
  for (const e of input.previous) {
    add(
      e,
      e.refs.filter(
        (r) =>
          input.projects.has(r.project) &&
          ((r.source === "agent" && !input.reread.has(r.project)) ||
            (r.source === "graph" && input.graphRead?.has(r.project) !== true)),
      ),
    );
  }
  for (const e of input.found) add(e, e.refs);
  return [...out.values()].filter((e) => e.known === undefined || input.projects.has(e.known));
}

const TIER_ORDER: readonly MapConfidence[] = ["extracted", "inferred", "ambiguous"];

/** The less sure of two tiers: a line is only as sure as its weakest proof. */
const weaker = (a: MapConfidence, b: MapConfidence): MapConfidence =>
  TIER_ORDER[Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))] as MapConfidence;

/** The lines the addresses make with what is known now. A line back to the project itself is not drawn. */
export function deriveLines(
  endpoints: readonly MapEndpoint[],
  resolutions: readonly MapResolution[],
  projects: ReadonlySet<string>,
): MapEdge[] {
  const lines = new Map<string, MapEdge>();
  for (const e of endpoints) {
    const owner = ownerOf(resolutions, e);
    if (owner === undefined || !projects.has(owner.project)) continue;
    for (const ref of e.refs) {
      if (ref.project === owner.project || !projects.has(ref.project)) continue;
      const proof = { project: ref.project, file: ref.file, line: ref.line, excerpt: ref.excerpt };
      // A file says it (config, or a call the code graph read): proven, not proposed.
      const fromFiles = ref.source !== "agent";
      const id = edgeId(ref.project, owner.project, "http");
      const had = lines.get(id);
      if (had === undefined) {
        lines.set(id, {
          id,
          from: ref.project,
          to: owner.project,
          type: "http",
          label: "HTTP",
          evidence: [proof],
          source: ref.source,
          state: fromFiles ? "confirmed" : "new",
          confidence: fromFiles ? weaker(owner.confidence, ref.confidence ?? "extracted") : "ambiguous",
        });
        continue;
      }
      const evidence = had.evidence.some((p) => p.file === proof.file && p.line === proof.line)
        ? had.evidence
        : [...had.evidence, proof].slice(0, REFS_MAX);
      // A file that says it outright beats a proposal; the stronger tier wins.
      const better = fromFiles && had.source === "agent";
      const tier = weaker(owner.confidence, ref.confidence ?? "extracted");
      // A line several files show is as sure as its surest proof.
      const surer = fromFiles && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(had.confidence);
      lines.set(id, {
        ...had,
        evidence,
        ...(better
          ? { source: ref.source, state: "confirmed" as const, confidence: tier }
          : surer
            ? { confidence: tier }
            : {}),
      });
    }
  }
  return [...lines.values()];
}
