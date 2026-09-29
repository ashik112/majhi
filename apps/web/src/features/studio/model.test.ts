import { describe, expect, it } from "vitest";
import { isStudioShortcut, parseStudioTab, searchString } from "./model";

const key = (over: Partial<Parameters<typeof isStudioShortcut>[0]>) => ({
  key: ".",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("parseStudioTab", () => {
  it("accepts the two tabs only", () => {
    expect(parseStudioTab("agents")).toBe("agents");
    expect(parseStudioTab("accounts")).toBe("accounts");
    expect(parseStudioTab("skills")).toBeUndefined();
  });
});

describe("isStudioShortcut", () => {
  it("needs Ctrl or Cmd and a period", () => {
    expect(isStudioShortcut(key({ metaKey: true }))).toBe(true);
    expect(isStudioShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isStudioShortcut(key({}))).toBe(false);
    expect(isStudioShortcut(key({ ctrlKey: true, key: "s" }))).toBe(false);
    expect(isStudioShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

describe("searchString", () => {
  it("keeps non-empty strings", () => {
    expect(searchString("a")).toBe("a");
    expect(searchString("")).toBeUndefined();
    expect(searchString(3)).toBeUndefined();
  });
});
