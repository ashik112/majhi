import { describe, expect, it } from "vitest";
import { orgKeys } from "./keys.ts";

describe("orgKeys", () => {
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
