import { describe, expect, it } from "vitest";
import { mentionNames } from "./chat-body.ts";

describe("mentionNames", () => {
  const text = "Thanks, @[contact:ct-1a2b3c4d]. And @[contact:ct-9z]!";

  it("reads a token as @Name from the message's own map, then from the contact list", () => {
    const names = { "ct-1a2b3c4d": "Sara" };
    expect(mentionNames(text, names, (id) => (id === "ct-9z" ? "Omar" : undefined))).toBe(
      "Thanks, @Sara. And @Omar!",
    );
  });

  it("never shows a token or an id for a contact nobody names", () => {
    expect(mentionNames(text)).toBe("Thanks, @contact. And @contact!");
  });
});
