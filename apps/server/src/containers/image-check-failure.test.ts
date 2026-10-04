import { describe, expect, it } from "vitest";
import { failureLine, hideValues } from "./image-check.ts";

describe("a failed script's line", () => {
  it("names the exit and the program's last error, not a guess", () => {
    expect(failureLine(1, "Error: unable to find database cluster\n")).toBe(
      "the program exited 1: Error: unable to find database cluster",
    );
    expect(failureLine(2, "")).toBe("the program exited 2 without saying why");
  });

  it("never carries a value the program was given", () => {
    const token = "dop_v1_abcdef0123456789";
    const line = failureLine(1, hideValues(`auth failed for token ${token}\n`, [token]));
    expect(line).not.toContain(token);
    expect(line).toContain("[redacted]");
  });
});
