import type { Finding, OwnerDecision } from "@majhi/shared";

/** Sample rows for the agenda tests. Generic names only. */

export function decision(over: Partial<OwnerDecision> & { id: string }): OwnerDecision {
  return {
    kind: "ship",
    title: "Ship the invoice export",
    options: [],
    at: "2026-10-04T06:00:00.000Z",
    link: { kind: "captain" },
    ...over,
  };
}

export function finding(over: Partial<Finding> & { id: number }): Finding {
  return {
    org: "acme",
    source: "security",
    title: "Outdated TLS setting",
    detail: "",
    evidence: [],
    severity: "high",
    dedupeKey: `k${over.id}`,
    status: "open",
    by: "captain",
    seen: 1,
    createdAt: "2026-10-03T12:00:00.000Z",
    updatedAt: "2026-10-03T12:00:00.000Z",
    lastSeen: "2026-10-03T12:00:00.000Z",
    ...over,
  };
}
