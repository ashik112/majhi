import { describe, expect, it } from "vitest";
import { LIMITS, SelfChecks, type SelfDeps } from "./self.ts";
import { MIN, opsWorld } from "./testing.ts";

/** majhi watching itself: a full disk, a stalled server, a stuck queue, Health's failing checks. */

const GB = 1_000_000_000;

function selfDeps(over: Partial<SelfDeps> = {}, memo = new Map<string, string>()): SelfDeps {
  return {
    health: async () => [],
    disks: async () => [{ label: "majhi data", path: "/Users/owner/.majhi" }],
    dbPath: () => "/Users/owner/.majhi/majhi.db",
    trees: async () => [
      {
        id: "self-tasks-size",
        label: "Task worktrees",
        path: "/Users/owner/Work/.majhi",
        failBytes: LIMITS.worktreesFailBytes,
      },
    ],
    queueStall: () => undefined,
    lagMs: () => 10,
    memory: () => ({ rss: 1 * GB, total: 16 * GB }),
    recall: { get: (k) => memo.get(k), set: (k, v) => void memo.set(k, v) },
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    freeBytes: async () => 100 * GB,
    sizeOf: async (p) => (p.endsWith("majhi.db") ? 200_000_000 : 3 * GB),
    ...over,
  };
}

const failing = (checks: Awaited<ReturnType<SelfChecks["measure"]>>) =>
  checks.filter((c) => c.status === "fail").map((c) => c.id);

describe("the measurements", () => {
  it("fail on a nearly full disk, a stalled event loop, memory, a stuck queue, a huge database and worktrees", async () => {
    const memo = new Map([["db-size:2026-10-03", "100000000"]]);
    const checks = await new SelfChecks(
      selfDeps(
        {
          freeBytes: async () => 0.4 * GB,
          lagMs: () => 7_000,
          memory: () => ({ rss: 12 * GB, total: 16 * GB }),
          queueStall: () => 45,
          sizeOf: async (p) => (p.endsWith("majhi.db") ? 2 * GB : 70 * GB),
          laya: async () => ({ state: "error", detail: "majhi cannot reach Docker to start Laya." }),
        },
        memo,
      ),
    ).measure();
    expect(failing(checks).sort()).toEqual(
      [
        "self-db-size",
        "self-disk-majhi-data",
        "self-event-loop",
        "self-laya",
        "self-memory",
        "self-queue",
        "self-tasks-size",
      ].sort(),
    );
    const disk = checks.find((c) => c.id === "self-disk-majhi-data");
    expect(disk?.severity).toBe("high");
  });
});

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
