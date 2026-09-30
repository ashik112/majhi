import { describe, expect, it } from "vitest";
import { MergeOrderCycle, mergeOrder, orderViolations, type ProjectGraph } from "./order.ts";

const graph = (links: Record<string, string[]>): ProjectGraph => new Map(Object.entries(links));

describe("mergeOrder", () => {
  it("puts a project others depend on first", () => {
    expect(mergeOrder(["web", "api"], graph({ web: ["api"] }))).toEqual(["api", "web"]);
  });

  it("keeps the task's order when nothing links the repos", () => {
    expect(mergeOrder(["web", "api", "docs"], graph({}))).toEqual(["web", "api", "docs"]);
  });

  it("keeps the task's order among repos a dependency does not separate", () => {
    // docs and web are free; api must precede web only.
    expect(mergeOrder(["web", "docs", "api"], graph({ web: ["api"] }))).toEqual(["docs", "api", "web"]);
  });

  it("follows a dependency through a project the task does not touch", () => {
    expect(mergeOrder(["web", "api"], graph({ web: ["shared"], shared: ["api"] }))).toEqual(["api", "web"]);
  });

  it("orders a chain", () => {
    expect(mergeOrder(["c", "b", "a"], graph({ c: ["b"], b: ["a"] }))).toEqual(["a", "b", "c"]);
  });

  it("refuses a loop and names it", () => {
    const err = catchError(() => mergeOrder(["a", "b"], graph({ a: ["b"], b: ["a"] })));
    expect(err).toBeInstanceOf(MergeOrderCycle);
    expect((err as MergeOrderCycle).path).toEqual(["a", "b", "a"]);
  });

  it("refuses a loop that runs through a project outside the task", () => {
    expect(() => mergeOrder(["a", "b"], graph({ a: ["x"], x: ["a"] }))).toThrow(MergeOrderCycle);
  });

  it("ignores a repeated project", () => {
    expect(mergeOrder(["a", "a", "b"], graph({}))).toEqual(["a", "b"]);
  });
});

describe("orderViolations", () => {
  it("reports a dependent placed before what it depends on", () => {
    expect(orderViolations(["web", "api"], graph({ web: ["api"] }))).toEqual([
      "web depends on api, but merges first",
    ]);
    expect(orderViolations(["api", "web"], graph({ web: ["api"] }))).toEqual([]);
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}
