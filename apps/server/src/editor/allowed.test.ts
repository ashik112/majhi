import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorPath, isInside } from "./allowed.ts";

describe("isInside", () => {
  it("accepts the folder itself and what is under it, but not a neighbour with the same prefix", () => {
    expect(isInside("/w/a", "/w/a")).toBe(true);
    expect(isInside("/w/a/b/c.ts", "/w/a")).toBe(true);
    expect(isInside("/w/ab", "/w/a")).toBe(false);
    expect(isInside("/w", "/w/a")).toBe(false);
    expect(isInside("/w/a/..cache", "/w/a")).toBe(true);
    expect(isInside("/w/a/../b", "/w/a")).toBe(false);
  });
});

describe("editorPath", () => {
  let dir: string;
  let root: string;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "majhi-editor-")));
    root = join(dir, "work");
    await mkdir(join(root, "repo"), { recursive: true });
    await mkdir(join(dir, "secret"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("allows a root, a folder and a file under it, including a folder named like ..cache", async () => {
    await mkdir(join(root, "..cache"));
    await writeFile(join(root, "repo", "a.ts"), "");
    expect(await editorPath(root, [root])).toBe(root);
    expect(await editorPath(join(root, "repo"), [root])).toBe(join(root, "repo"));
    expect(await editorPath(join(root, "repo", "a.ts"), [root])).toBe(join(root, "repo", "a.ts"));
    expect(await editorPath(join(root, "..cache"), [root])).toBe(join(root, "..cache"));
  });

  it("says there is nothing there for a path that does not exist, also behind a link that leads out", async () => {
    await expect(editorPath(join(root, "repo", "new.ts"), [root])).rejects.toThrow();
    await symlink(join(dir, "secret"), join(root, "link"));
    await expect(editorPath(join(root, "link", "new.ts"), [root])).rejects.toThrow();
  });

  it("refuses a path outside the roots, including one that climbs out with ..", async () => {
    await expect(editorPath(join(dir, "secret"), [root])).rejects.toThrow();
    await expect(editorPath(join(root, "..", "secret"), [root])).rejects.toThrow();
    await expect(editorPath("/etc/passwd", [root])).rejects.toThrow();
  });

  it("refuses a link inside a root that leads out of it", async () => {
    await symlink(join(dir, "secret"), join(root, "link"));
    await expect(editorPath(join(root, "link"), [root])).rejects.toThrow();
  });

  it("refuses a relative path and a NUL byte", async () => {
    await expect(editorPath("repo", [root])).rejects.toThrow();
    await expect(editorPath(`${root}/a\0b`, [root])).rejects.toThrow();
  });
});
