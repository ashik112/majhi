import { BRIEF_BULLETS, BRIEF_SECTIONS, BRIEF_WORDS } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { applyPatch, BULLET_WORDS, bulletWords, parseBrief, wordCount } from "./brief-doc.ts";

const sentence = (i: number) =>
  `Handler ${i} in src/handlers/h${i}.ts answers the Acme probe within two seconds.`;
const prose = (n: number) => Array.from({ length: n }, (_, i) => sentence(i)).join(" ");

describe("brief shape", () => {
  it("writes every section as at most six one-line bullets and the whole under the word cap", () => {
    const patch = Object.fromEntries(BRIEF_SECTIONS.map((s) => [s, prose(20)]));
    const body = applyPatch(undefined, patch) ?? "";
    const sections = parseBrief(body);
    let total = 0;
    for (const s of BRIEF_SECTIONS) {
      const lines = sections[s].split("\n");
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(BRIEF_BULLETS);
      for (const line of lines) {
        expect(line).toMatch(/^- \S/);
        expect(wordCount(line.slice(2))).toBeLessThanOrEqual(BULLET_WORDS + 1);
      }
      total += bulletWords(sections[s]);
    }
    expect(total).toBeLessThanOrEqual(BRIEF_WORDS);
  });

  it("turns list items into bullets and cuts a long one to one line", () => {
    const long = "word ".repeat(80).trim();
    const body = applyPatch(undefined, {
      "What it is": "1. The Acme api.\n* Serves the Globex app.",
      Architecture: `- ${long}`,
    });
    const sections = parseBrief(body ?? "");
    expect(sections["What it is"]).toBe("- The Acme api.\n- Serves the Globex app.");
    expect(sections.Architecture.split("\n")).toHaveLength(1);
    expect(wordCount(sections.Architecture)).toBe(1 + BULLET_WORDS + 1);
    expect(sections["Known problems"]).toBe("Nothing yet.");
  });

  it("changes nothing when a patch says the same thing in the same bullets", () => {
    const body = applyPatch(undefined, {
      "Current state": prose(3),
      Architecture: `- ${"word ".repeat(80)}`,
    });
    expect(body).toBeDefined();
    const again = parseBrief(body ?? "");
    expect(
      applyPatch(body, { "Current state": again["Current state"], Architecture: again.Architecture }),
    ).toBe(undefined);
  });
});
