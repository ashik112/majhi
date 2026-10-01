import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepSerenaOutOfGit } from "./serena.ts";

const dirs: string[] = [];
async function temp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "majhi-serena-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("keepSerenaOutOfGit", () => {
  it("makes .serena with a .gitignore that ignores everything, and leaves an existing one alone", async () => {
    const worktree = await temp();
    expect(await keepSerenaOutOfGit(worktree)).toEqual({ ok: true });
    expect(await readFile(join(worktree, ".serena", ".gitignore"), "utf8")).toBe("*\n");
    await writeFile(join(worktree, ".serena", ".gitignore"), "/cache\n");
    expect(await keepSerenaOutOfGit(worktree)).toEqual({ ok: true });
    expect(await readFile(join(worktree, ".serena", ".gitignore"), "utf8")).toBe("/cache\n");
  });

  it("writes nothing and leaves Serena out when .serena is a link to a folder outside the worktree", async () => {
    const worktree = await temp();
    const outside = await temp();
    await symlink(outside, join(worktree, ".serena"));
    const result = await keepSerenaOutOfGit(worktree);
    expect(result.ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it("refuses a .gitignore that is a link, and writes through nothing", async () => {
    const worktree = await temp();
    const outside = await temp();
    await mkdir(join(worktree, ".serena"));
    await writeFile(join(outside, "target"), "keep\n");
    await symlink(join(outside, "target"), join(worktree, ".serena", ".gitignore"));
    const result = await keepSerenaOutOfGit(worktree);
    expect(result.ok).toBe(false);
    expect(await readFile(join(outside, "target"), "utf8")).toBe("keep\n");
  });

  it("refuses a .serena that is a file", async () => {
    const worktree = await temp();
    await writeFile(join(worktree, ".serena"), "x");
    expect((await keepSerenaOutOfGit(worktree)).ok).toBe(false);
  });
});
