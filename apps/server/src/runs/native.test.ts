import { describe, expect, it } from "vitest";
import { NativeWatch, sharpDrop } from "./native.ts";

describe("compactions the CLI does on its own", () => {
  it("records Claude's report once, with the tokens it gives", () => {
    const w = new NativeWatch();
    expect(w.report({ type: "compaction", id: "c1", status: "started" }, 150_000)).toBeUndefined();
    // The first terminal report has no facts yet: wait for them.
    expect(w.report({ type: "compaction", id: "c1", status: "completed" }, 150_000)).toBeUndefined();
    expect(
      w.report({ type: "compaction", id: "c1", trigger: "auto", before: 160_000, after: 40_000 }, 150_000),
    ).toEqual({ before: 160_000, after: 40_000 });
    // A duplicate terminal report and the reading after it are the same compaction.
    expect(w.report({ type: "compaction", id: "c1", status: "completed" }, 150_000)).toBeUndefined();
    expect(w.usage(160_000, 40_000)).toBeUndefined();
  });

  it("takes the size after from the next reading when the adapter gives none (Codex)", () => {
    const w = new NativeWatch();
    w.report({ type: "compaction", id: "i1", status: "started" }, 170_000);
    expect(w.report({ type: "compaction", id: "i1", status: "completed" }, 170_000)).toBeUndefined();
    expect(w.usage(170_000, 30_000)).toEqual({ before: 170_000, after: 30_000 });
    expect(w.usage(30_000, 35_000)).toBeUndefined();
  });

  it("does not take a reading in the middle of a compaction for the size after", () => {
    const w = new NativeWatch();
    w.report({ type: "compaction", id: "i2", status: "started" }, 170_000);
    expect(w.usage(170_000, 20_000)).toBeUndefined();
    expect(w.report({ type: "compaction", id: "i2", status: "completed" }, 20_000)).toBeUndefined();
    expect(w.usage(20_000, 22_000)).toEqual({ before: 170_000, after: 22_000 });
  });

  it("skips a manual compaction and the drop it makes", () => {
    const w = new NativeWatch();
    expect(
      w.report(
        {
          type: "compaction",
          id: "m1",
          status: "completed",
          trigger: "manual",
          before: 90_000,
          after: 9_000,
        },
        90_000,
      ),
    ).toBeUndefined();
    expect(w.usage(90_000, 9_000)).toBeUndefined();
  });

  it("records nothing for a compaction that failed", () => {
    const w = new NativeWatch();
    w.report({ type: "compaction", id: "f1", status: "started" }, 150_000);
    expect(w.report({ type: "compaction", id: "f1", status: "failed" }, 150_000)).toBeUndefined();
    expect(w.usage(150_000, 152_000)).toBeUndefined();
  });

  it("spots a compaction from a sharp drop between two readings when nothing reported it", () => {
    const w = new NativeWatch();
    expect(w.usage(undefined, 160_000)).toBeUndefined();
    expect(w.usage(160_000, 40_000)).toEqual({ before: 160_000, after: 40_000 });
    expect(w.usage(40_000, 45_000)).toBeUndefined();
  });

  it("forgets a report that was open when majhi took over", () => {
    const w = new NativeWatch();
    w.report({ type: "compaction", id: "c3", status: "completed" }, 150_000);
    w.reset();
    expect(w.usage(150_000, 140_000)).toBeUndefined();
  });

  it("counts only falls a compaction makes", () => {
    expect(sharpDrop(160_000, 40_000)).toBe(true);
    // Small swings, between turns or in reasoning, are not compactions.
    expect(sharpDrop(160_000, 120_000)).toBe(false);
    expect(sharpDrop(30_000, 12_000)).toBe(false);
  });
});
