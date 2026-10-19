import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isBelow, isInside } from "./fs.ts";

describe("path containment", () => {
  const cases: Array<[string, string, string, boolean, boolean]> = [
    // [what, path, root, isInside, isBelow]
    ["the root itself", "/w/a", "/w/a", true, false],
    ["a file under the root", "/w/a/b/c.ts", "/w/a", true, true],
    ["a neighbour with the same prefix", "/w/ab", "/w/a", false, false],
    ["the parent of the root", "/w", "/w/a", false, false],
    ["a name that only starts with dots", "/w/a/..cache", "/w/a", true, true],
    ["a path that climbs out with ..", "/w/a/../b", "/w/a", false, false],
    ["a path that climbs out and back in", "/w/a/x/../y", "/w/a", true, true],
    ["an unrelated absolute path", "/etc/passwd", "/w/a", false, false],
  ];
  it.each(cases)("%s", (_what, path, root, inside, below) => {
    expect(isInside(path, root)).toBe(inside);
    expect(isBelow(path, root)).toBe(below);
  });

  describe("a link that leads out", () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("reads as inside as written and outside once both are resolved", async () => {
      dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-inside-")));
      const root = join(dir, "work");
      const secret = join(dir, "secret");
      await mkdir(root);
      await mkdir(secret);
      await symlink(secret, join(root, "link"));
      const viaLink = join(root, "link");
      expect(isInside(viaLink, root)).toBe(true);
      expect(isInside(await realpath(viaLink), await realpath(root))).toBe(false);
    });
  });
});
