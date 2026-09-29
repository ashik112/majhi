import { describe, expect, it } from "vitest";
import { isUpdateReady, sameCommit } from "./version.ts";

describe("isUpdateReady", () => {
  it("is ready when the checkout is at a different commit", () => {
    expect(isUpdateReady("aaaaaaa", "bbbbbbb")).toBe(true);
  });

  it("is not ready when the commits match, in full or by prefix", () => {
    expect(isUpdateReady("abc1234", "abc1234def")).toBe(false);
    expect(isUpdateReady("abc1234def", "abc1234")).toBe(false);
  });

  it("cannot compare an image built without a commit, or a missing helper", () => {
    expect(isUpdateReady("dev", "bbbbbbb")).toBe(false);
    expect(isUpdateReady("aaaaaaa", undefined)).toBe(false);
    expect(sameCommit("dev", "dev")).toBe(false);
  });
});
