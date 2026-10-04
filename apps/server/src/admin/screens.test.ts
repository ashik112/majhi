import { PAGE_PATH, SETUP_SECTIONS } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { ADMIN_PREAMBLE } from "./boss.ts";

const mapLines = (): string[] => {
  const lines = ADMIN_PREAMBLE.split("\n");
  return lines.slice(lines.indexOf("majhi's screens:") + 1);
};

describe("the screen map in the captain's prompt", () => {
  it("names real pages and settings, with their paths", () => {
    expect(mapLines()).toEqual(
      expect.arrayContaining([
        "Sidebar > Needs you (/decisions)",
        "Sidebar > Watch (/watch)",
        "Sidebar foot > Health & usage (/usage)",
        "Settings > Access > Connections (/connections)",
        "Settings > Agents > Memory rules (/setup?section=memory)",
        "Settings > General > Overview (/setup)",
        "Palette (Cmd K) > Today (/today)",
      ]),
    );
  });

  it("points every line at a page majhi has, and every page has a line", () => {
    const pages = new Set<string>(Object.values(PAGE_PATH));
    const seen = new Set<string>();
    for (const line of mapLines()) {
      const match = / \((\/[a-z]*)(?:\?section=([a-z0-9]+))?\)$/.exec(line);
      expect(match, line).not.toBeNull();
      const [, path = "", section] = match ?? [];
      expect(pages.has(path), line).toBe(true);
      if (section !== undefined) expect(SETUP_SECTIONS, line).toContain(section);
      seen.add(path);
    }
    expect([...pages].filter((path) => !seen.has(path))).toEqual([]);
  });
});
