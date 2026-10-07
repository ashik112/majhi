import { boardCounts } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { workCountsOf } from "./model.ts";

const rows = [{ org: "acme", task: "ACM-1" }, { org: "globex", task: "GLX-2" }, { task: "LOCAL-3" }, {}];
const counts = boardCounts(rows, [{ task: "ACM-9", org: "acme" }]);

describe("the one needs-you count", () => {
  it("reads every decision, whatever its kind or workspace", () => {
    expect(workCountsOf(counts)?.needsYou).toBe(4);
  });

  it("reads a workspace's own, with Private for a task of none and nothing for an account", () => {
    expect(workCountsOf(counts, "acme")).toEqual({ needsYou: 1, working: 1 });
    expect(workCountsOf(counts, "private")?.needsYou).toBe(1);
    expect(workCountsOf(counts, "missing")).toEqual({ needsYou: 0, working: 0 });
  });
});
