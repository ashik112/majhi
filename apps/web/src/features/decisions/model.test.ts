import { describe, expect, it } from "vitest";
import { needsYouCount } from "./model.ts";

const rows = [
  { org: "acme", task: "ACM-1" },
  { org: "globex", task: "GLX-2" },
  { task: "LOCAL-3" },
  {},
];

describe("the one needs-you count", () => {
  it("counts every decision, whatever its kind or workspace", () => {
    expect(needsYouCount(rows)).toBe(4);
  });

  it("counts a workspace's own, with Private for a task of none and nothing for an account", () => {
    expect(needsYouCount(rows, "acme")).toBe(1);
    expect(needsYouCount(rows, "private")).toBe(1);
    expect(needsYouCount(rows, "missing")).toBe(0);
  });

  it("is unknown, not zero, until the list has loaded", () => {
    expect(needsYouCount(undefined)).toBeUndefined();
    expect(needsYouCount([])).toBe(0);
  });
});
