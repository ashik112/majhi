import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editorPath } from "./allowed.ts";

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

  it("refuses a path outside the roots, including one that climbs out with ..", async () => {
    await expect(editorPath(join(dir, "secret"), [root])).rejects.toThrow();
    await expect(editorPath(join(root, "..", "secret"), [root])).rejects.toThrow();
    await expect(editorPath("/etc/passwd", [root])).rejects.toThrow();
  });
});
