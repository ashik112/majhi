import { describe, expect, it } from "vitest";
import { relayLine } from "./rollup-post.ts";

describe("a lane message in the root chat", () => {
  it("keeps the first paragraph on one line", () => {
    expect(relayLine("PYZ-4 and PYZ-5 are done.\nPYZ-14 was a duplicate.\n\n**Next:** more")).toBe(
      "PYZ-4 and PYZ-5 are done. PYZ-14 was a duplicate.",
    );
  });

  it("cuts a long first paragraph at a word", () => {
    const line = relayLine(`${"word ".repeat(100)}end`);
    expect(line.length).toBeLessThanOrEqual(325);
    expect(line.endsWith("…")).toBe(true);
  });
});
