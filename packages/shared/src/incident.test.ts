import { describe, expect, it } from "vitest";
import { clientStatus, type StatusFacts } from "./incident.ts";

const t = (hhmm: string): string => `2026-10-07T${hhmm}:00.000Z`;

/** An incident opened at 10:00, judged at 12:00, with a 15 minute soak. */
function facts(over: Partial<StatusFacts> = {}): StatusFacts {
  return {
    openedAt: t("10:00"),
    reopenedAt: [],
    deploysPending: false,
    soakMin: 15,
    now: t("12:00"),
    ...over,
  };
}

describe("the status a client sees", () => {
  it("is Investigating while nothing is known", () => {
    expect(clientStatus(facts()).status).toBe("investigating");
  });

  it("is Identified once a cause is marked or a fix exists", () => {
    const r = clientStatus(facts({ identifiedAt: t("10:12") }));
    expect(r.status).toBe("identified");
    expect(r.at.identified).toBe(t("10:12"));
  });

  it("is Monitoring once the fix is live, with the watch still firing or soaking", () => {
    expect(clientStatus(facts({ identifiedAt: t("10:12"), liveAt: t("10:41"), watch: {} })).status).toBe(
      "monitoring",
    );
    const soaking = clientStatus(
      facts({ liveAt: t("10:41"), watch: { greenAt: t("10:50") }, now: t("11:00") }),
    );
    expect(soaking.status).toBe("monitoring");
    expect(soaking.soakEndsAt).toBe(t("11:05"));
  });

  it("is Resolved when the watch stayed green for the soak after the fix went live", () => {
    const r = clientStatus(facts({ liveAt: t("10:41"), watch: { greenAt: t("10:50") }, now: t("11:05") }));
    expect(r.status).toBe("resolved");
    expect(r.at.resolved).toBe(t("11:05"));
  });

  it("does not resolve on a watch that went green before the fix was live until the soak runs from the fix", () => {
    const r = clientStatus(facts({ liveAt: t("10:41"), watch: { greenAt: t("10:30") }, now: t("10:50") }));
    expect(r.status).toBe("monitoring");
  });

  it("with no watch, resolves when the task is done and its deploys are live", () => {
    const done = clientStatus(facts({ doneAt: t("10:50"), liveAt: t("10:41") }));
    expect(done.status).toBe("resolved");
    expect(done.at.resolved).toBe(t("10:50"));
    expect(clientStatus(facts({ doneAt: t("10:50") })).status).toBe("resolved");
    // A deploy that has not gone live yet holds it back.
    expect(clientStatus(facts({ doneAt: t("10:50"), deploysPending: true })).status).toBe("investigating");
    // Live but the task is not done: not resolved.
    expect(clientStatus(facts({ liveAt: t("10:41"), now: t("10:50") })).status).toBe("monitoring");
    // Live for the soak with no watch to look at: resolved.
    expect(clientStatus(facts({ liveAt: t("10:41"), now: t("11:00") })).status).toBe("resolved");
  });

  it("a watch that went green with nothing shipped is only recovered: the incident stays open", () => {
    const r = clientStatus(facts({ watch: { greenAt: t("10:30") }, now: t("13:00") }));
    expect(r.status).toBe("investigating");
    expect(r.recoveredAt).toBe(t("10:30"));
    // The owner closing it after the recovery resolves it once the soak has run.
    const closed = clientStatus(
      facts({ watch: { greenAt: t("10:30") }, doneAt: t("10:45"), now: t("13:00") }),
    );
    expect(closed.status).toBe("resolved");
    expect(closed.at.resolved).toBe(t("11:00"));
  });

  it("needs a shipped fix AND a green watch for the soak to resolve", () => {
    // Fix live but the watch is still firing.
    expect(clientStatus(facts({ liveAt: t("10:41"), watch: {}, now: t("13:00") })).status).toBe("monitoring");
    // Fix live, watch green, soak not over.
    const soaking = clientStatus(
      facts({ liveAt: t("10:41"), watch: { greenAt: t("10:50") }, now: t("10:55") }),
    );
    expect(soaking.status).toBe("monitoring");
    expect(soaking.soakEndsAt).toBe(t("11:05"));
  });

  it("is reopened by a client who says it is still broken, even while the watch is green", () => {
    const resolved = facts({ liveAt: t("10:41"), watch: { greenAt: t("10:50") }, now: t("11:30") });
    expect(clientStatus(resolved).status).toBe("resolved");
    const again = clientStatus({ ...resolved, reopenedAt: [t("11:40")], now: t("12:00") });
    expect(again.status).toBe("investigating");
    expect(again.at.investigating).toBe(t("11:40"));
    // Only a new fix live resolves it again, and the soak runs from that fix.
    const fixed = clientStatus({
      ...resolved,
      reopenedAt: [t("11:40")],
      liveAt: t("11:50"),
      now: t("12:00"),
    });
    expect(fixed.status).toBe("monitoring");
    expect(
      clientStatus({ ...resolved, reopenedAt: [t("11:40")], liveAt: t("11:50"), now: t("12:05") }).status,
    ).toBe("resolved");
  });

  it("a reopened incident with no watch needs the task done again", () => {
    const base = facts({ doneAt: t("10:50"), reopenedAt: [t("11:00")] });
    expect(clientStatus(base).status).toBe("investigating");
    expect(clientStatus({ ...base, doneAt: t("11:30") }).status).toBe("resolved");
  });
});
