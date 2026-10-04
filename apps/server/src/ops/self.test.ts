import { describe, expect, it } from "vitest";
import { type HealthLike, LIMITS, SelfChecks, type SelfDeps } from "./self.ts";
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
  it("pass on a healthy machine", async () => {
    const checks = await new SelfChecks(selfDeps()).measure();
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      "self-event-loop",
      "self-memory",
      "self-disk-majhi-data",
      "self-db-size",
      "self-queue",
      "self-tasks-size",
    ]);
  });

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
    expect(disk?.detail).toContain("0.4 GB free");
    expect(checks.find((c) => c.id === "self-db-size")?.detail).toContain("more than yesterday");
  });

  it("do not say a measurement they could not take", async () => {
    const checks = await new SelfChecks(
      selfDeps({
        freeBytes: async () => {
          throw new Error("no such disk");
        },
        sizeOf: async () => undefined,
        trees: async () => {
          throw new Error("config does not load");
        },
      }),
    ).measure();
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(["self-event-loop", "self-memory", "self-queue"]);
  });

  it("ask du for a folder's size once an hour, not every five minutes", async () => {
    let asked = 0;
    let at = new Date("2026-10-04T10:00:00.000Z");
    const checks = new SelfChecks(
      selfDeps({
        now: () => at,
        sizeOf: async (p) => {
          if (p.endsWith("majhi.db")) return 1;
          asked += 1;
          return GB;
        },
      }),
    );
    await checks.measure();
    at = new Date(at.getTime() + 5 * MIN);
    await checks.measure();
    expect(asked).toBe(1);
    at = new Date(at.getTime() + 60 * MIN);
    await checks.measure();
    expect(asked).toBe(2);
  });

  it("join Health's checks, and only the urgent ones are high", async () => {
    const health: HealthLike[] = [
      { id: "disk", name: "Disk space", status: "fail", detail: "0.4 GB free", fix: undefined },
      {
        id: "account:claude-acme",
        name: "Account claude-acme",
        status: "fail",
        detail: "Signed out",
        fix: { label: "Sign in" },
      },
    ];
    const all = await new SelfChecks(selfDeps({ health: async () => health })).all();
    expect(all.find((c) => c.id === "disk")?.severity).toBe("high");
    expect(all.find((c) => c.id === "account:claude-acme")?.severity).toBe("medium");
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
      title: "majhi: Disk space is failing",
      severity: "high",
      fix: { check: "disk", label: "Create folder" },
    });
    expect(inc?.service).toBeUndefined();
    expect(w.alerts.map((a) => a.severity)).toEqual(["high"]);
    expect(w.wakes).toHaveLength(1);
    expect(w.wakes[0]?.org).toBe("private");
    expect(w.wakes[0]?.text).toContain("majhi's own check");
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

  it("a blip is nothing, and a warning is never an incident", async () => {
    const w = opsWorld();
    await w.ops.watch.watchSelf([disk("fail")]);
    w.advance(5 * MIN);
    await w.ops.watch.watchSelf([disk("pass")]);
    w.advance(5 * MIN);
    await w.ops.watch.watchSelf([disk("pass")]);
    w.advance(5 * MIN);
    await w.ops.watch.watchSelf([disk("fail")]);
    expect(w.ops.repo.open()).toEqual([]);
    const warn = { ...disk("pass"), status: "warn" as const };
    for (let i = 0; i < 4; i++) {
      w.advance(5 * MIN);
      await w.ops.watch.watchSelf([warn]);
    }
    expect(w.ops.repo.open()).toEqual([]);
  });

  it("closes after it has been fine for the resolve time, or when the check is gone", async () => {
    const w = opsWorld();
    for (let i = 0; i < 2; i++) {
      await w.ops.watch.watchSelf([disk("fail")]);
      w.advance(5 * MIN);
    }
    expect(w.ops.repo.open()).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      await w.ops.watch.watchSelf([disk("pass")]);
      w.advance(5 * MIN);
    }
    expect(w.ops.repo.open()).toEqual([]);
    expect(w.ops.repo.recent(1)[0]?.timeline.at(-1)?.kind).toBe("resolved");

    const gone = opsWorld();
    for (let i = 0; i < 2; i++) {
      await gone.ops.watch.watchSelf([disk("fail")]);
      gone.advance(5 * MIN);
    }
    for (let i = 0; i < 4; i++) {
      await gone.ops.watch.watchSelf([]);
      gone.advance(5 * MIN);
    }
    expect(gone.ops.repo.open()).toEqual([]);
  });

  it("an unacknowledged high self-incident escalates like any other, and shows in Decisions", async () => {
    const w = opsWorld();
    for (let i = 0; i < 2; i++) {
      await w.ops.watch.watchSelf([disk("fail")]);
      w.advance(1 * MIN);
    }
    expect(w.ops.watch.unacked()).toHaveLength(1);
    w.advance(10 * MIN);
    await w.ops.watch.tick();
    expect(w.alerts.map((a) => a.repeat)).toEqual([false, true]);
  });
});
