import { describe, expect, it } from "vitest";
import { addresses, asksByWords, mentionText, quietNote } from "./mentions.ts";

/** A lead's handoff after a status paragraph, written the way leads write them. */
const HANDOFF = [
  "Plan v3 is recorded. The server part starts now.",
  "",
  "@acme-builder: please build the server side of the export in this worktree, on branch task/acm-7-export. Keep the API as in the plan.",
].join("\n");

describe("asksByWords", () => {
  it.each([
    ["the handoff after a status paragraph", HANDOFF],
    ["a colon and please", "@acme-builder: please build the importer."],
    ["a comma and a verb", "@acme-builder, review the diff."],
    ["a colon and a verb", "@acme-builder: build the server side next."],
    ["please without punctuation", "@acme-builder please add a test."],
    [
      "please after a status paragraph",
      "The web part is done and checked.\n\n@acme-builder please take the server part.",
    ],
    ["the ask on the line after the address", "@acme-builder:\nplease build the Globex importer."],
    [
      "a please sentence after the mention",
      "The web part is done, @acme-builder. Please build the server part next.",
    ],
    ["a verb after a sentence addressed to it", "@acme-builder the staging build is up. Run the smoke test."],
    ["a list item in bold", "Next steps:\n- **@acme-builder**: please wire the route."],
    ["please in the middle", "Next, @acme-builder please port the Northwind sync."],
  ])("asks: %s", (_, text) => {
    expect(asksByWords(text, "acme-builder")).toBe(true);
  });

  it.each([
    ["thanks", "Thanks @acme-builder, that is all from me for now."],
    ["as someone said", "As @acme-builder said, the cache is warm."],
    ["status", "@acme-builder is done, nothing to do."],
    ["a possessive", "I'm still waiting. @acme-builder's check is running."],
    ["a report about it", "Approved. @acme-builder did the fix in commit 7a8b9c0, nothing more from me."],
    ["another agent asked", "@acme-reviewer: please review what @acme-builder wrote."],
    ["a longer name", "@acme-builder-two: please build it."],
    ["in code", "Run `@acme-builder: please build` to see it."],
    ["the later status after a noted", "Noted, @acme-builder. The Northwind sync is done on your side."],
  ])("does not ask: %s", (_, text) => {
    expect(asksByWords(text, "acme-builder")).toBe(false);
  });
});

describe("addresses", () => {
  it.each([
    ["a colon", "@lead: please review"],
    ["a name alone", "@lead"],
    ["a bold list item", "- **@lead**: review the diff"],
    ["a numbered list item", "1. @lead take the server part"],
    ["a new line after a status sentence", "Tests pass.\n@lead please merge"],
    ["a new sentence on the same line", "Tests pass. @lead the build is up."],
    ["a run of names", "@builder @lead: please look at the diff"],
    ["a run of names with commas and and", "@builder, @reviewer and @lead: sync up"],
    ["another case", "@Lead: hello"],
  ])("addresses: %s", (_, text) => {
    expect(addresses(text, "lead")).toBe(true);
  });

  it.each([
    ["reported to", "Reported to @lead, I'm mentioning no one, so this wakes nobody."],
    ["results posted for", "Done: tests pass. Results are posted for @lead. Nothing else for me."],
    ["as said", "proc-3 ended green, as @lead said. No action needed."],
    ["thanks", "Thanks @lead."],
    ["a question at the end", "Done, can you review it @lead?"],
    ["a name inside a longer one", "@lead-two: please review"],
    ["a name in code", "Run `@lead: please review` in the shell."],
    ["a name in a quote", "> @lead: please review"],
    ["an email", "Mail me at dev@lead.example"],
    ["a name after a run of other names", "@builder: ask @lead later"],
  ])("does not address: %s", (_, text) => {
    expect(addresses(text, "lead")).toBe(false);
  });

  it("tells the writer how to hand work on", () => {
    expect(quietNote(["lead"])).toContain('start a line with "@name: please ..."');
  });
});

describe("mentionText", () => {
  it("keeps the sentence after the mention, where a long handoff puts the ask", () => {
    const filler = Array.from({ length: 40 }, (_, i) => `Step ${i + 1} of the plan is recorded.`).join(" ");
    const text = `Plan v3 is recorded. ${filler}\n\n@acme-builder:\nbuild the server side of the export.\n\nUnrelated closing line.`;
    expect(mentionText(text, ["acme-builder"], 300)).toBe(
      "Plan v3 is recorded. @acme-builder: build the server side of the export.",
    );
  });
});
