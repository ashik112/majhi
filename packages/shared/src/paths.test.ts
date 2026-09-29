import { describe, expect, it } from "vitest";
import { protectedFolder } from "./paths.ts";

const HOME = "/Users/owner";

describe("protectedFolder", () => {
  it.each([
    ["~/Documents", "Documents"],
    ["~/Documents/work/api", "Documents"],
    ["/Users/owner/Desktop", "Desktop"],
    ["~/Downloads/", "Downloads"],
    ["~/Library/Mobile Documents/com~apple~CloudDocs/code", "iCloud Drive"],
    ["~/documents", "Documents"],
  ])("flags %s as %s", (path, folder) => {
    expect(protectedFolder(path, HOME)).toBe(folder);
  });

  it.each([
    "~/Work",
    "~/Documents-old",
    "~/code/Documents",
    "/Volumes/Documents",
    "/Users/other/Documents",
    "~",
    "~/Library/Caches",
  ])("leaves %s alone", (path) => {
    expect(protectedFolder(path, HOME)).toBeUndefined();
  });
});
