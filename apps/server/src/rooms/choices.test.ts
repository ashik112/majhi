import { describe, expect, it } from "vitest";
import { readChoices } from "./choices.ts";

describe("readChoices", () => {
  it("reads a numbered list that a question introduces", () => {
    const text = [
      "@owner, Phase 4 is ready for your review. What next?",
      "",
      "1. Merge into main",
      "2. Ask for changes",
      "3. Start Phase 5",
    ].join("\n");
    expect(readChoices(text)).toEqual(["Merge into main", "Ask for changes", "Start Phase 5"]);
  });

  it("takes the bold part or the part before a dash as the label", () => {
    const text = [
      "Two ways to fix the flaky test. Which do you prefer?",
      "- **Retry once** - quick, hides the race",
      "- Fix the race: slower, but real",
    ].join("\n");
    expect(readChoices(text)).toEqual(["Retry once", "Fix the race"]);
  });

  it("reads a bulleted list with a cue before a colon and a question after it", () => {
    const text = "Options:\n* Merge now\n* Wait for CI\n\nWhich one should I do?";
    expect(readChoices(text)).toEqual(["Merge now", "Wait for CI"]);
  });

  it("ignores a list of what was done", () => {
    const text = "Done:\n- Added the health endpoint\n- Fixed the tests\n\nLet me know if you want changes.";
    expect(readChoices(text)).toEqual([]);
  });

  it("ignores a list of long sentences", () => {
    const text = [
      "What should I do next?",
      "1. Rewrite the whole auth module so that every call goes through the new token cache first",
      "2. Leave it",
    ].join("\n");
    expect(readChoices(text)).toEqual([]);
  });

  it("ignores a list followed by more prose", () => {
    const text = "Which one?\n- A\n- B\nMore detail.\nEven more.\nAnd more.";
    expect(readChoices(text)).toEqual([]);
  });

  it('reads "A or B" in a question', () => {
    expect(readChoices("The branch is clean. Should I merge now or wait for review?")).toEqual([
      "Merge now",
      "Wait for review",
    ]);
  });

  it('reads "X, Y or Z" in a question', () => {
    expect(readChoices("@owner do you want Postgres, SQLite, or DuckDB?")).toEqual([
      "Postgres",
      "SQLite",
      "DuckDB",
    ]);
  });

  it("offers nothing for an open question or an unclear one", () => {
    expect(readChoices("What port should the server use?")).toEqual([]);
    expect(readChoices("Should I merge or not?")).toEqual([]);
    expect(readChoices("Is this ready or does it need more tests?")).toEqual([]);
    expect(
      readChoices(
        "Should I rewrite the importer so it streams rows or keep loading the whole file in memory?",
      ),
    ).toEqual([]);
  });

  it("skips code blocks", () => {
    expect(readChoices("```\nShould I a or b?\n```\nDone.")).toEqual([]);
  });
});
