import { describe, expect, it } from "vitest";
import { plainAuthorityText, splitReady } from "./plain-text.ts";

describe("plain wording of stored captain text", () => {
  it("rewrites a sentence about an old level into the authority sentence, once", () => {
    expect(
      plainAuthorityText(
        "Checks pass. Umbrella is set to Keeps things tidy, so the captain asks before shipping. Acme is set to Runs it, so it merges.",
        "Umbrella",
      ),
    ).toBe("Checks pass. In Umbrella you decide when work is merged.");
  });

  it("drops an old-level sentence that is not about shipping and leaves clean text alone", () => {
    expect(plainAuthorityText("Looks safe. Acme is set to Only when I ask.", "Acme")).toBe("Looks safe.");
    expect(plainAuthorityText("Keeps a backup branch,  nothing pushed", "Acme")).toBe(
      "Keeps a backup branch, nothing pushed",
    );
  });

  it("names no workspace when it does not know one", () => {
    expect(plainAuthorityText("It is set to Runs it, so it ships.")).toBe(
      "In this workspace you decide when work is merged.",
    );
  });

  it("splits the ready line into what was checked and what the captain adds", () => {
    expect(
      splitReady(
        "Ready to ship to main: committed, merges cleanly into main, no card waits. Acme is set to Keeps things tidy, so the captain asks before shipping.",
        "Acme",
      ),
    ).toEqual({
      checks: "committed, merges cleanly into main, no card waits",
      note: "In Acme you decide when work is merged.",
    });
    expect(splitReady("Looks fine to me")).toEqual({ note: "Looks fine to me" });
  });
});
