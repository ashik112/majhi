import { describe, expect, it } from "vitest";
import { deriveKey, orgKeys } from "./keys.ts";

describe("deriveKey", () => {
  it.each([
    ["Acme Corp", "AC"],
    ["Globex", "IDE"],
    ["acme", "ACM"],
    ["Big Old Company Ltd", "BOCL"],
    ["A", "A"],
    ["3M Labs", "ML"],
    ["42", "ORG"],
  ])("%s gives %s", (name, key) => {
    expect(deriveKey(name, "42")).toBe(key);
  });

  it("falls back to the id when the name has no letters", () => {
    expect(deriveKey("123", "beta-org")).toBe("BET");
  });
});

describe("orgKeys", () => {
  it("keeps explicit keys and derives the rest", () => {
    const keys = orgKeys({ globex: { name: "Globex", key: "GLX" }, acme: { name: "Acme Corp" } });
    expect([...keys]).toEqual([
      ["globex", "GLX"],
      ["acme", "AC"],
    ]);
  });

  it("makes derived keys unique, and never uses LOCAL", () => {
    const keys = orgKeys({
      one: { name: "Acme" },
      two: { name: "Acmeco" },
      three: { name: "Local" },
      four: { name: "Ac Me", key: "ACM" },
    });
    expect(keys.get("four")).toBe("ACM");
    expect(keys.get("one")).toBe("ACM2");
    expect(keys.get("two")).toBe("ACM3");
    expect(keys.get("three")).toBe("LOC");
  });

  it("does not move an earlier org's key when a later org arrives", () => {
    const before = orgKeys({ a: { name: "Acme" } });
    const after = orgKeys({ a: { name: "Acme" }, b: { name: "Acme Two" } });
    expect(before.get("a")).toBe("ACM");
    expect(after.get("a")).toBe("ACM");
    expect(after.get("b")).toBe("AT");
  });
});
