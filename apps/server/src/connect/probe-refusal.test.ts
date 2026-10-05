import { describe, expect, it } from "vitest";
import { refusalReason } from "./oauth.ts";

describe("probeToken", () => {
  it("the reason never carries a token and stays short", () => {
    const r = refusalReason(null, JSON.stringify({ error: "bad Bearer abc123 here" }));
    expect(r).not.toContain("abc123");
    expect(refusalReason(null, JSON.stringify({ message: "m".repeat(500) })).length).toBe(200);
  });
});
