import { describe, expect, it } from "vitest";
import { MIN, opsWorld } from "./testing.ts";

/** majhi watching itself: a full disk, a stalled server, a stuck queue, Health's failing checks. */

describe("a failing self-check is an incident in Private", () => {
  const disk = (status: "pass" | "fail") => ({
    id: "disk",
    name: "Disk space",
    status,
    detail: status === "fail" ? "0.4 GB free for ~/Work/.majhi" : "40 GB free",
    fix: { label: "Create folder" },
    severity: "high" as const,
  });

  it("opens after two failing reads in a row, with the fix button and a wake for Private", async () => {
    const w = opsWorld();
    await w.ops.watch.watchSelf([disk("fail")]);
    expect(w.ops.repo.open()).toEqual([]);
    w.advance(5 * MIN);
    await w.ops.watch.watchSelf([disk("fail")]);
    const [inc] = w.ops.repo.open();
    expect(inc).toMatchObject({
      org: "private",
      severity: "high",
      fix: { check: "disk", label: "Create folder" },
    });
    expect(inc?.service).toBeUndefined();
    expect(w.alerts.map((a) => a.severity)).toEqual(["high"]);
    expect(w.wakes).toHaveLength(1);
    expect(w.wakes[0]?.org).toBe("private");
    // The finding is in Private, source incident.
    expect(w.findings.list({ org: "private", limit: 10 }, { kind: "owner" }).findings[0]).toMatchObject({
      org: "private",
      source: "incident",
    });
    // It stays one incident while the disk stays full.
    for (let i = 0; i < 4; i++) {
      w.advance(5 * MIN);
      await w.ops.watch.watchSelf([disk("fail")]);
    }
    expect(w.ops.repo.open()).toHaveLength(1);
    expect(w.alerts).toHaveLength(1);
  });
});
