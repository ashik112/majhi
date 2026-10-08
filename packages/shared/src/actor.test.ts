import { describe, expect, it } from "vitest";
import { type Actor, CAPTAIN, didWords, didWordsInline, MAJHI, OWNER } from "./actor.ts";

const ACTORS: Actor[] = [OWNER, CAPTAIN, MAJHI, { kind: "agent", id: "ada" }];

describe("who did it", () => {
  it("never words an action by anyone else as the owner's", () => {
    const words = ACTORS.map((a) => didWords(a, "acknowledged", "it"));
    expect(words).toEqual([
      "You acknowledged it",
      "The captain acknowledged it",
      "majhi acknowledged it",
      "@ada acknowledged it",
    ]);
    expect(words.filter((w) => w.startsWith("You"))).toHaveLength(1);
    expect(ACTORS.map((a) => didWordsInline(a, "cancelled", "it"))).toEqual([
      "you cancelled it",
      "the captain cancelled it",
      "majhi cancelled it",
      "@ada cancelled it",
    ]);
  });

  it("names no one for a row from before actors were kept", () => {
    expect(didWords(undefined, "acknowledged", "it")).toBe("Acknowledged it");
  });
});
