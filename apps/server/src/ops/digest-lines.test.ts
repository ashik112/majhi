import type { OpsIncident } from "@majhi/shared";
import { expect, it } from "vitest";
import { incidentLines } from "./digest-lines.ts";

const inc = (id: number, org: string, extra: Partial<OpsIncident> = {}): OpsIncident => ({
  id,
  org,
  title: `Incident ${id}`,
  severity: "medium",
  status: "open",
  openedAt: "2026-10-01T10:00:00Z",
  flaps: 0,
  timeline: [],
  ...extra,
});

it("lists one workspace's open incidents, unacknowledged first, then worst, never another's", () => {
  const lines = incidentLines(
    [
      inc(1, "acme", { severity: "high", ackedAt: "2026-10-01T10:05:00Z" }),
      inc(2, "acme", { severity: "low" }),
      inc(3, "globex", { severity: "high" }),
      inc(4, "acme", { severity: "medium", watch: "wch-ab12cd" }),
      inc(5, "acme", { status: "resolved" }),
    ],
    "acme",
  );
  expect(lines).toEqual([
    "incident #4 [medium, not acknowledged] Incident 4 (watch wch-ab12cd)",
    "incident #2 [low, not acknowledged] Incident 2",
    "incident #1 [high, acknowledged] Incident 1",
  ]);
});
