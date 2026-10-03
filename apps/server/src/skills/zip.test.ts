import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { makeZip } from "../testing/zip.ts";
import { copyFolder, describeFolder } from "./files.ts";
import { extractZip } from "./zip.ts";

describe("extracting a zip", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  it("unpacks files under the folder", async () => {
    const zip = makeZip([
      { name: "demo/SKILL.md", data: "---\nname: demo\ndescription: d\n---\n" },
      { name: "demo/ref/a.md", data: "hi" },
      { name: "demo/ref/", data: "" },
      { name: "__MACOSX/demo/._SKILL.md", data: "x" },
    ]);
    const dest = join(dir, "out");
    expect(await extractZip(zip, dest)).toEqual(["demo/SKILL.md", "demo/ref/a.md"]);
    expect(await readFile(join(dest, "demo/ref/a.md"), "utf8")).toBe("hi");
    expect(await exists(join(dest, "__MACOSX"))).toBe(false);
  });

  it.each([
    ["a parent folder", "../evil.txt"],
    ["a parent folder deeper in", "demo/../../evil.txt"],
    ["an absolute path", "/tmp/evil.txt"],
    ["backslashes", "..\\evil.txt"],
    ["a drive letter", "C:/evil.txt"],
  ])("refuses an entry with %s and writes nothing outside", async (_what, name) => {
    const dest = join(dir, "nested", "out");
    await mkdir(dest, { recursive: true });
    const zip = makeZip([
      { name: "demo/SKILL.md", data: "ok" },
      { name, data: "owned" },
    ]);
    await expect(extractZip(zip, dest)).rejects.toThrow(/not allowed|leaves its folder/);
    expect(await exists(join(dir, "evil.txt"))).toBe(false);
    expect(await exists(join(dir, "nested", "evil.txt"))).toBe(false);
    expect(await exists("/tmp/evil.txt")).toBe(false);
    // The first entry may have been written inside; nothing is anywhere else.
    expect(await readdir(dir)).toEqual(["nested"]);
  });

  it("refuses a symlink entry", async () => {
    const zip = makeZip([{ name: "demo/link", data: "/etc/passwd", mode: 0o120777 }]);
    await expect(extractZip(zip, join(dir, "out"))).rejects.toThrow(/symlink/);
  });

  it("refuses what is not a zip, and an entry that lies about its size", async () => {
    await expect(extractZip(Buffer.from("nope"), join(dir, "out"))).rejects.toThrow(/not a zip/);
  });
});

describe("copying a skill folder", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
  });
  afterEach(() => cleanup());

  it("refuses a symlink that points outside the folder, and one to a folder", async () => {
    const src = join(dir, "src");
    await mkdir(src);
    await writeFile(join(dir, "secret.txt"), "top secret");
    await writeFile(join(src, "SKILL.md"), "x");
    await symlink(join(dir, "secret.txt"), join(src, "notes.md"));
    await expect(copyFolder(src, join(dir, "to"))).rejects.toThrow(/points outside/);
    await expect(describeFolder(src)).rejects.toThrow(/points outside/);
  });

  it("copies a link to a file inside the folder as that file", async () => {
    const src = join(dir, "src");
    await mkdir(src);
    await writeFile(join(src, "SKILL.md"), "x");
    await writeFile(join(src, "real.md"), "real");
    await symlink(join(src, "real.md"), join(src, "alias.md"));
    await copyFolder(src, join(dir, "to"));
    expect(await readFile(join(dir, "to", "alias.md"), "utf8")).toBe("real");
  });
});
