import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDirs, MAX_ENTRIES } from "./listDirs.ts";

describe("listDirs", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "majhi-host-test-")));
  });
  afterEach(async () => {
    await chmod(home, 0o755).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  });

  const dirs = (...paths: string[]) =>
    Promise.all(paths.map((p) => mkdir(join(home, p), { recursive: true })));

  it("lists subfolders by name without regard to case, marks repos, and hides dot-folders and ~/Library", async () => {
    await dirs("beta", "Alpha", "gamma/.git", "Library", ".config", "worktree", "node_modules", "v10", "v2");
    await writeFile(join(home, "worktree", ".git"), "gitdir: /elsewhere\n");
    await writeFile(join(home, "notes.txt"), "not a folder");

    const listing = await listDirs({ path: "~", showHidden: false }, home);

    expect(listing).toMatchObject({ path: home, home, truncated: false });
    expect(listing.entries).toEqual([
      { name: "Alpha", path: join(home, "Alpha"), isRepo: false, hidden: false },
      { name: "beta", path: join(home, "beta"), isRepo: false, hidden: false },
      { name: "gamma", path: join(home, "gamma"), isRepo: true, hidden: false },
      { name: "node_modules", path: join(home, "node_modules"), isRepo: false, hidden: false },
      { name: "v2", path: join(home, "v2"), isRepo: false, hidden: false },
      { name: "v10", path: join(home, "v10"), isRepo: false, hidden: false },
      { name: "worktree", path: join(home, "worktree"), isRepo: false, hidden: false },
    ]);
  });

  it("shows dot-folders on request, and Library below home", async () => {
    await dirs(".config", "Work/Library");
    const top = await listDirs({ path: home, showHidden: true }, home);
    expect(top.entries.map((e) => [e.name, e.hidden])).toEqual([
      [".config", true],
      ["Work", false],
    ]);
    const work = await listDirs({ path: "~/Work", showHidden: false }, home);
    expect(work.entries.map((e) => e.name)).toEqual(["Library"]);
    expect(work.parent).toBe(home);
  });

  it("lists a symlink to a folder under its own name, as a repo when its target is one, and skips broken links", async () => {
    await dirs("real/app/.git", "real/plain");
    await mkdir(join(home, "links"));
    await symlink(join(home, "real", "app"), join(home, "links", "app-link"));
    await symlink(join(home, "real", "plain"), join(home, "links", "plain-link"));
    await symlink(join(home, "missing"), join(home, "links", "broken"));
    await writeFile(join(home, "file"), "x");
    await symlink(join(home, "file"), join(home, "links", "file-link"));

    const listing = await listDirs({ path: "~/links", showHidden: false }, home);
    expect(listing.entries).toEqual([
      { name: "app-link", path: join(home, "links", "app-link"), isRepo: true, hidden: false },
      { name: "plain-link", path: join(home, "links", "plain-link"), isRepo: false, hidden: false },
    ]);
  });

  it("resolves a symlinked folder to its real path", async () => {
    await dirs("real/inside");
    await symlink(join(home, "real"), join(home, "alias"));
    const listing = await listDirs({ path: join(home, "alias"), showHidden: false }, home);
    expect(listing.path).toBe(join(home, "real"));
    expect(listing.entries.map((e) => e.path)).toEqual([join(home, "real", "inside")]);
  });

  it(`returns at most ${MAX_ENTRIES} folders and says it left some out`, async () => {
    await dirs(...Array.from({ length: MAX_ENTRIES + 5 }, (_, i) => `many/d${String(i).padStart(4, "0")}`));
    const listing = await listDirs({ path: "~/many", showHidden: false }, home);
    expect(listing.entries).toHaveLength(MAX_ENTRIES);
    expect(listing.entries.at(-1)?.name).toBe(`d${String(MAX_ENTRIES - 1).padStart(4, "0")}`);
    expect(listing.truncated).toBe(true);
  });

  it("has no parent at the filesystem root", async () => {
    const listing = await listDirs({ path: "/", showHidden: false }, home);
    expect(listing.path).toBe("/");
    expect(listing.parent).toBeNull();
  });

  it("explains paths it cannot list", async () => {
    await writeFile(join(home, "file.txt"), "x");
    await expect(listDirs({ path: "Work", showHidden: false }, home)).rejects.toThrow(
      "Use an absolute path, or one starting with ~/",
    );
    await expect(listDirs({ path: "~/nope", showHidden: false }, home)).rejects.toThrow(
      `There is no folder at ${join(home, "nope")}`,
    );
    await expect(listDirs({ path: "~/file.txt", showHidden: false }, home)).rejects.toThrow(
      `${join(home, "file.txt")} is not a folder`,
    );
    await dirs("locked");
    await chmod(join(home, "locked"), 0o000);
    try {
      await expect(listDirs({ path: "~/locked", showHidden: false }, home)).rejects.toThrow(
        `majhi does not have permission to read ${join(home, "locked")}`,
      );
    } finally {
      await chmod(join(home, "locked"), 0o755);
    }
  });
});
