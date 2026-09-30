import { describe, expect, it } from "vitest";
import {
  type AccountLoad,
  ASK_WAIT_MS,
  estimateWaitMs,
  fitsAccount,
  humanWait,
  likelyPaths,
  linkIsRedundant,
  moduleOf,
  overlapsOf,
  overlapWith,
  type PlanInput,
  planStart,
  sizeOf,
} from "./planning.ts";

describe("paths", () => {
  it("names the module of a file or a folder", () => {
    expect(moduleOf("apps/server/src/runs/manager.ts")).toBe("apps/server/src/runs");
    expect(moduleOf("apps/server/src/runs/")).toBe("apps/server/src/runs");
    expect(moduleOf("packages/shared/src/tasks.ts")).toBe("packages/shared/src");
    expect(moduleOf("README.md")).toBe(".");
  });

  it("reads paths and file names from a description, and skips links", () => {
    const text =
      "Fix apps/server/src/runs/manager.ts and the folder apps/web/src/features/room/. See https://example.com/docs/a/b, then update README.md. Version 1.2.3.";
    expect(likelyPaths(text)).toEqual([
      "apps/server/src/runs/manager.ts",
      "apps/web/src/features/room/",
      "README.md",
    ]);
  });
});

describe("overlap", () => {
  it("is heavy for the same file or a folder that holds it", () => {
    expect(overlapWith(["apps/server/src/runs/manager.ts"], ["apps/server/src/runs/manager.ts"]).level).toBe(
      "heavy",
    );
    expect(overlapWith(["apps/server/src/runs/"], ["apps/server/src/runs/run.ts"]).level).toBe("heavy");
  });

  it("is heavy when most of the new task sits in the other task's modules", () => {
    const o = overlapWith(
      ["apps/server/src/runs/a.ts", "apps/server/src/runs/b.ts"],
      ["apps/server/src/runs/c.ts"],
    );
    expect(o.level).toBe("heavy");
    expect(o.modules).toEqual(["apps/server/src/runs"]);
  });

  it("is little for one path in a shared module, and none for other modules", () => {
    expect(
      overlapWith(["apps/server/src/runs/a.ts", "docs/PROGRESS.md"], ["apps/server/src/runs/c.ts"]).level,
    ).toBe("little");
    expect(overlapWith(["apps/web/src/app.tsx"], ["apps/server/src/runs/c.ts"]).level).toBe("none");
  });

  it("is unknown when either side names nothing", () => {
    expect(overlapWith([], ["a/b/c.ts"]).level).toBe("unknown");
    expect(overlapWith(["a/b/c.ts"], []).level).toBe("unknown");
  });

  it("takes the worst footprint per task and ignores other projects", () => {
    const likely = new Map([["api", ["apps/server/src/runs/a.ts"]]]);
    const out = overlapsOf(likely, [
      { task: "ACM-1", project: "api", paths: ["docs/x.md"], changed: true },
      { task: "ACM-1", project: "api", paths: ["apps/server/src/runs/a.ts"], changed: true },
      { task: "ACM-2", project: "web", paths: ["apps/server/src/runs/a.ts"], changed: true },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ task: "ACM-1", level: "heavy" });
  });

  it("only calls a link redundant when the paths are known and disjoint", () => {
    expect(linkIsRedundant({ level: "none", files: [], modules: [] })).toBe(true);
    expect(linkIsRedundant({ level: "unknown", files: [], modules: [] })).toBe(false);
    expect(linkIsRedundant({ level: "little", files: [], modules: ["a"] })).toBe(false);
    expect(linkIsRedundant(undefined)).toBe(false);
  });
});

describe("limits", () => {
  const window = (usedPct: number) => ({ window: { usedPct }, weekly: { usedPct: 10 } });

  it("fits a free account and an account without numbers", () => {
    expect(fitsAccount({ usage: window(20), running: 0 }, "normal").fits).toBe(true);
    expect(fitsAccount({ usage: null, running: 5 }, "large").fits).toBe(true);
  });

  it("counts the tasks already running on the account", () => {
    expect(fitsAccount({ usage: window(70), running: 0 }, "normal").fits).toBe(true);
    expect(fitsAccount({ usage: window(70), running: 3 }, "normal").fits).toBe(false);
  });

  it("says which window runs out and when it resets", () => {
    const fit = fitsAccount(
      { usage: { window: { usedPct: 90, resetsAt: "2026-10-01T10:00:00Z" } }, running: 0 },
      "normal",
    );
    expect(fit.fits).toBe(false);
    expect(fit.why).toContain("5-hour window");
    expect(fit.resetsAt).toBe("2026-10-01T10:00:00Z");
  });

  it("stops on the weekly window too", () => {
    const fit = fitsAccount({ usage: { weekly: { usedPct: 94 } }, running: 0 }, "large");
    expect(fit.fits).toBe(false);
    expect(fit.why).toContain("weekly window");
  });

  it("sizes a task from its text and paths", () => {
    expect(sizeOf("Rename a field", ["a/b.ts"])).toBe("small");
    expect(sizeOf("x".repeat(1000), [])).toBe("normal");
    expect(sizeOf("x", ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"])).toBe("large");
  });
});

describe("planStart", () => {
  const loads: Record<string, AccountLoad> = {
    a: { usage: { window: { usedPct: 30 } }, running: 0 },
    b: { usage: { window: { usedPct: 30 } }, running: 0 },
  };
  const base = (over: Partial<PlanInput> = {}): PlanInput => ({
    size: "normal",
    agent: { agent: "lead", account: "a" },
    alternatives: [{ agent: "builder", account: "b" }],
    load: (account) => loads[account] ?? { usage: null, running: 0 },
    overlaps: [],
    running: [],
    ...over,
  });
  const heavy = {
    task: "ACM-1",
    project: "api",
    level: "heavy" as const,
    files: [],
    modules: ["apps/server/src/runs"],
  };

  it("starts when nothing overlaps", () => {
    expect(planStart(base())).toEqual({ action: "start" });
  });

  it("starts with a note on little overlap", () => {
    const v = planStart(base({ overlaps: [{ ...heavy, level: "little" }] }));
    expect(v.action).toBe("start");
  });

  it("waits on heavy overlap with a short wait", () => {
    const v = planStart(base({ overlaps: [heavy], running: [{ id: "ACM-1", runningMs: 20 * 60_000 }] }));
    expect(v).toMatchObject({ action: "wait", on: ["ACM-1"] });
  });

  it("asks the owner when the wait is long", () => {
    const v = planStart(base({ overlaps: [heavy], running: [{ id: "ACM-1", runningMs: 2 * 3_600_000 }] }));
    expect(v).toMatchObject({ action: "ask", on: ["ACM-1"], module: "apps/server/src/runs" });
  });

  it("switches to an agent on another account when the first is short", () => {
    const short: Record<string, AccountLoad> = {
      ...loads,
      a: { usage: { window: { usedPct: 92 } }, running: 0 },
    };
    const v = planStart(base({ load: (acc) => short[acc] ?? { usage: null, running: 0 } }));
    expect(v).toMatchObject({ action: "switch", agent: { agent: "builder", account: "b" } });
  });

  it("queues when no account fits, and says when the window resets", () => {
    const full: AccountLoad = {
      usage: { window: { usedPct: 96, resetsAt: "2026-10-01T10:00:00Z" } },
      running: 0,
    };
    const v = planStart(base({ load: () => full }));
    expect(v).toMatchObject({ action: "queue", until: "2026-10-01T10:00:00Z" });
  });

  it("never picks an alternative on the same account", () => {
    const short: AccountLoad = { usage: { window: { usedPct: 96 } }, running: 0 };
    const v = planStart(base({ load: () => short, alternatives: [{ agent: "second", account: "a" }] }));
    expect(v.action).toBe("queue");
  });
});

describe("waits", () => {
  it("estimates as long as the running task has run, at least ten minutes", () => {
    const running = [
      { id: "ACM-1", runningMs: 3 * 60_000 },
      { id: "ACM-2", runningMs: 90 * 60_000 },
    ];
    expect(estimateWaitMs(["ACM-1"], running)).toBe(10 * 60_000);
    expect(estimateWaitMs(["ACM-1", "ACM-2"], running)).toBe(90 * 60_000);
    expect(ASK_WAIT_MS).toBe(3_600_000);
  });

  it("puts a wait in words", () => {
    expect(humanWait(7 * 60_000)).toBe("about 7 minutes");
    expect(humanWait(40 * 60_000)).toBe("about 40 minutes");
    expect(humanWait(2 * 3_600_000)).toBe("about 2 hours");
  });
});
