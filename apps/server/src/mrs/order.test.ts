import { describe, expect, it } from "vitest";
import { MergeOrderCycle, mergeOrder, type ProjectGraph } from "./order.ts";

const graph = (links: Record<string, string[]>): ProjectGraph => new Map(Object.entries(links));

describe("mergeOrder", () => {
  it("puts a project others depend on first", () => {
    expect(mergeOrder(["web", "api"], graph({ web: ["api"] }))).toEqual(["api", "web"]);
  });

  it("refuses a loop and names it", () => {
    const err = catchError(() => mergeOrder(["a", "b"], graph({ a: ["b"], b: ["a"] })));
    expect(err).toBeInstanceOf(MergeOrderCycle);
    expect((err as MergeOrderCycle).path).toEqual(["a", "b", "a"]);
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
