import { describe, expect, it } from "vitest";
import { type People, parseBody, renderPlain } from "./format.ts";

/** One fixed message: bold, code, a link, a list, and a mention with a username and one without. */
const SAMPLE = [
  "Hi @[contact:ct-sara], the **Acme & Globex** build is _live_: run `a < b` now.",
  "See [the notes](https://example.com/n?a=1&b=2).",
  "- first <one>",
  "- second",
  "```\nx > 1 && y\n```",
  "Also @[contact:ct-omar] and @[contact:ct-lee].",
].join("\n\n");

const people: People = (id) =>
  ({
    "ct-sara": { name: "Sara", native: "111", username: "sara_k" },
    "ct-omar": { name: "Omar <O>", native: "222" },
  })[id];

describe("one body, each app's markup", () => {
  const body = parseBody(SAMPLE);

  it("keeps the names in plain words, which the secret scan reads", () => {
    expect(renderPlain(body, people)).toContain("Hi @Sara, the Acme & Globex build is live");
  });
});
