import { edgeId, type MapEdge, type ProjectMap } from "@majhi/shared";
import { deriveLines } from "./endpoints.ts";

/** Lines drawn from the addresses of a map, with the owner's checks kept from `before`. */
export function linesFrom(
  map: Pick<ProjectMap, "endpoints" | "resolutions">,
  projects: ReadonlySet<string>,
  before: readonly MapEdge[],
): MapEdge[] {
  const checked = new Set(before.filter((e) => e.state === "confirmed").map((e) => e.id));
  return deriveLines(map.endpoints, map.resolutions, projects).map((e) =>
    e.source === "agent" && checked.has(e.id) ? { ...e, state: "confirmed" as const } : e,
  );
}

/**
 * Records what the owner says an address is (or forgets it, without `to`) and draws the lines again from the
 * stored addresses: the answer shows at once and every later update applies it too.
 */
export function answerAddress(
  map: ProjectMap,
  address: { host: string; port: number | undefined; scope: string | undefined },
  to: ProjectMap["resolutions"][number]["to"] | undefined,
): ProjectMap {
  const same = (r: ProjectMap["resolutions"][number]) =>
    r.host === address.host && r.port === address.port && r.scope === address.scope;
  const resolutions = [
    ...map.resolutions.filter((r) => !same(r)),
    ...(to === undefined
      ? []
      : [
          {
            host: address.host,
            ...(address.port === undefined ? {} : { port: address.port }),
            ...(address.scope === undefined ? {} : { scope: address.scope }),
            to,
          },
        ]),
  ];
  const projects = new Set(map.nodes.filter((n) => n.project !== undefined).map((n) => n.id));
  const removed = new Set(map.removed.map((r) => edgeId(r.from, r.to, r.type)));
  const derived = linesFrom({ endpoints: map.endpoints, resolutions }, projects, map.edges).filter(
    (e) => !removed.has(e.id),
  );
  // Every line of the address kind is drawn again; the files' own lines (library, queue, data) stay.
  const rest = map.edges.filter((e) => e.type !== "http");
  return { ...map, resolutions, edges: [...rest, ...derived] };
}
