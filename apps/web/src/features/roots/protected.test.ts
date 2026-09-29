import { describe, expect, it } from "vitest";
import { protectedRoots, protectedWarning } from "./model";

const HOME = "/Users/owner";
const rows = (...values: string[]) => values.map((value, id) => ({ id, value }));

describe("protectedRoots", () => {
  it("finds roots and the tasks folder inside macOS-protected folders", () => {
    expect(
      protectedRoots(rows("~/Documents/code", "~/Work", "/Users/owner/Desktop"), "~/Downloads/t", HOME),
    ).toEqual([
      { path: "~/Documents/code", folder: "Documents" },
      { path: "~/Desktop", folder: "Desktop" },
      { path: "~/Downloads/t", folder: "Downloads" },
    ]);
  });

  it("finds nothing for ordinary folders and blank rows", () => {
    expect(protectedRoots(rows("~/Work", "  "), "", HOME)).toEqual([]);
  });

  it("names the runtime and asks the owner to click Allow", () => {
    const found = protectedRoots(rows("~/Documents"), "", HOME);
    expect(protectedWarning(found, "OrbStack")).toBe(
      "macOS will ask whether OrbStack may access your Documents folder. Click Allow when it asks, or majhi cannot see it.",
    );
  });
});
