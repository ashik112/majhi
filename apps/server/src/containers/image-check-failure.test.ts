import { describe, expect, it } from "vitest";
import { exitMessage, failureLine, hideValues } from "./image-check.ts";

describe("a failed script's line", () => {
  it("names the exit and the program's last error, not a guess", () => {
    expect(failureLine(1, "Error: unable to find database cluster\n")).toBe(
      "the program exited 1: Error: unable to find database cluster",
    );
    expect(failureLine(2, "")).toBe("the program exited 2 without saying why");
  });

  it("names the missing program when a script exits 127, and keeps the old line when nothing was said", () => {
    expect(exitMessage(127, "sh: 2: doctl: not found\n")).toBe("the program exited 127: sh: 2: doctl: not found");
    expect(exitMessage(127, "")).toBe("majhi problem: the client program is missing from the image.");
    expect(exitMessage(22, "curl: (22) The requested URL returned error: 401\n")).toBe(
      "the program exited 22: curl: (22) The requested URL returned error: 401",
    );
  });

  it("never carries a value the program was given", () => {
    const token = "dop_v1_abcdef0123456789";
    const line = failureLine(1, hideValues(`auth failed for token ${token}\n`, [token]));
    expect(line).not.toContain(token);
    expect(line).toContain("[redacted]");
  });
});
