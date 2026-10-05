import { describe, expect, it } from "vitest";
import { failureLine, hideValues } from "./image-check.ts";

describe("a failed script's line", () => {
  it("never carries a value the program was given", () => {
    const token = "dop_v1_abcdef0123456789";
    const line = failureLine(1, hideValues(`auth failed for token ${token}\n`, [token]));
    expect(line).not.toContain(token);
    expect(line).toContain("[redacted]");
  });
});
