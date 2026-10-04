import type { OpsIncident } from "@majhi/shared";

const RANK = { high: 3, medium: 2, low: 1 } as const;

/**
 * Open incidents of one workspace as digest lines for its captain lane: unacknowledged first, then the
 * worst, then the newest. Another workspace's incidents never appear. A watch's incident names the watch.
 */
export function incidentLines(open: readonly OpsIncident[], org: string): string[] {
  return open
    .filter((i) => i.org === org && i.status === "open")
    .toSorted(
      (a, b) =>
        Number(a.ackedAt !== undefined) - Number(b.ackedAt !== undefined) ||
        RANK[b.severity] - RANK[a.severity] ||
        b.id - a.id,
    )
    .map(
      (i) =>
        `incident #${i.id} [${i.severity}${i.ackedAt === undefined ? ", not acknowledged" : ", acknowledged"}] ${i.title}${i.watch === undefined ? "" : ` (watch ${i.watch})`}${i.finding === undefined ? "" : `, finding #${i.finding}`}`,
    );
}
