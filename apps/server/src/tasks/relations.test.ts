import { describe, expect, it } from "vitest";
import { findCycle, isMet, type LinkRow, parentIsComplete, unmetDependencies } from "./relations.ts";

const dep = (task: string, other: string, when?: "merged" | "ready"): LinkRow => ({
  task,
  type: "depends-on",
  other,
  when,
});
const parent = (task: string, other: string): LinkRow => ({ task, type: "parent", other });

describe("findCycle", () => {
  it("refuses a self link", () => {
    expect(findCycle([], "depends-on", "A-1", "A-1")).toEqual(["A-1", "A-1"]);
  });

  it("finds a direct and a longer dependency loop and names the path", () => {
    expect(findCycle([dep("A-2", "A-1")], "depends-on", "A-1", "A-2")).toEqual(["A-1", "A-2", "A-1"]);
    const rows = [dep("A-2", "A-3"), dep("A-3", "A-4")];
    const path = findCycle(rows, "depends-on", "A-4", "A-2");
    expect(path).toEqual(["A-4", "A-2", "A-3", "A-4"]);
  });

  it("finds a loop in the parent chain", () => {
    const rows = [parent("A-2", "A-1"), parent("A-3", "A-2")];
    expect(findCycle(rows, "parent", "A-1", "A-3")).toEqual(["A-1", "A-3", "A-2", "A-1"]);
    expect(findCycle(rows, "parent", "A-4", "A-1")).toBeUndefined();
  });
});

describe("waiting on", () => {
  it("counts merged as done, and ready as review, mr or done", () => {
    expect(isMet("merged", "review")).toBe(false);
    expect(isMet(undefined, "mr")).toBe(false);
    expect(isMet("merged", "done")).toBe(true);
    expect(isMet("ready", "running")).toBe(false);
    expect(isMet("ready", "review")).toBe(true);
  });
});

describe("parentIsComplete", () => {
  it("needs at least one child and all of them done", () => {
    expect(parentIsComplete([])).toBe(false);
    expect(parentIsComplete(["done", "review"])).toBe(false);
    expect(parentIsComplete(["done", "done"])).toBe(true);
  });
});

describe("a merged dependency with merge requests", () => {
  it("is met only when the task is done and no merge request is left open or closed", () => {
    expect(isMet("merged", "done", false)).toBe(true);
    expect(isMet("merged", "done", true)).toBe(false);
    expect(isMet("merged", "mr", false)).toBe(false);
    // `ready` does not look at merge requests.
    expect(isMet("ready", "review", true)).toBe(true);
  });

  it("keeps a waiting task waiting for a closed task whose MRs are not merged", () => {
    const links = [dep("A-2", "A-1", "merged"), dep("A-2", "A-3", "merged")];
    const status = (id: string) => (id === "A-1" || id === "A-3" ? ("done" as const) : undefined);
    expect(unmetDependencies(links, status, (id) => id === "A-1")).toEqual(["A-1"]);
    expect(unmetDependencies(links, status, () => false)).toEqual([]);
  });
});
