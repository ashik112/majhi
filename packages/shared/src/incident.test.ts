import { describe, expect, it } from "vitest";
import { clientStatus, type StatusFacts } from "./incident.ts";

const base: StatusFacts = {
  openedAt: "2026-10-20T09:00:00.000Z",
  reopenedAt: [],
  deploysPending: false,
  soakMin: 15,
  now: "2026-10-20T10:00:00.000Z",
};
const at = (hhmm: string): string => `2026-10-20T${hhmm}:00.000Z`;

describe("an incident is resolved only by a shipped fix and a watch that stayed green", () => {
  it.each<[string, Partial<StatusFacts>, string, string | undefined]>([
    // The fix went live at 10:00, the checks went green at 10:05, the soak is 15 minutes: the later of the two plus 15.
    [
      "Monitoring one minute before the soak ends",
      { liveAt: at("10:00"), watch: { greenAt: at("10:05") }, now: at("10:19") },
      "monitoring",
      undefined,
    ],
    [
      "Resolved when the soak ends",
      { liveAt: at("10:00"), watch: { greenAt: at("10:05") }, now: at("10:20") },
      "resolved",
      at("10:20"),
    ],
    // Green with nothing shipped is a recovery on its own, never a resolution.
    [
      "Investigating when the watch is green and nothing shipped",
      { watch: { greenAt: at("10:05") }, now: at("12:00") },
      "investigating",
      undefined,
    ],
    // A fix older than the last reopen does not count: the client said it was still broken at 11:00.
    [
      "Investigating again after a client said it is still broken",
      { reopenedAt: [at("11:00")], liveAt: at("10:00"), watch: { greenAt: at("10:05") }, now: at("12:00") },
      "investigating",
      undefined,
    ],
  ])("%s", (_name, facts, status, resolvedAt) => {
    const result = clientStatus({ ...base, ...facts });
    expect(result.status).toBe(status);
    expect(result.at.resolved).toBe(resolvedAt);
  });
});
