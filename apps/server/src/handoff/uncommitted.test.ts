import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeRepo, tempDir, git as testGit } from "../testing/fixtures.ts";
import { uncommittedFiles, uncommittedFromStatus } from "./ready.ts";

/** What blocks a hand-off as uncommitted work, against real git. */

let cleanup: () => Promise<void>;
let repo: string;

beforeEach(async () => {
  let dir: string;
  ({ dir, cleanup } = await tempDir());
  repo = join(dir, "api");
  await makeRepo(repo, { commit: true });
  await writeFile(join(repo, "tracked.ts"), "export const a = 1;\n");
  await testGit(repo, "add", ".");
  await testGit(repo, "commit", "--quiet", "-m", "add tracked");
});
afterEach(async () => cleanup());

async function put(path: string, text = "x\n"): Promise<void> {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), text);
}

describe("uncommitted work at hand-off", () => {
  it("passes a worktree with only an untracked package store and node_modules", async () => {
    await put(".pnpm-store/v3/files/ab/cdef");
    await put("node_modules/left-pad/index.js");
    await put("apps/web/node_modules/x/index.js");
    expect(await uncommittedFiles(repo)).toEqual([]);
  });

  it("passes ignored files", async () => {
    await put(".gitignore", "build-output/\n");
    await testGit(repo, "add", ".gitignore");
    await testGit(repo, "commit", "--quiet", "-m", "ignore");
    await put("build-output/a.js");
    expect(await uncommittedFiles(repo)).toEqual([]);
  });

  it("blocks a modified tracked file", async () => {
    await put("tracked.ts", "export const a = 2;\n");
    await put(".pnpm-store/v3/files/ab/cdef");
    expect(await uncommittedFiles(repo)).toEqual(["tracked.ts"]);
  });

  it("blocks a new untracked source file", async () => {
    await put("src/new.ts");
    await put(".pnpm-store/v3/files/ab/cdef");
    expect(await uncommittedFiles(repo)).toEqual(["src/new.ts"]);
  });

  it("blocks a tracked file under node_modules that changed", () => {
    expect(uncommittedFromStatus(" M node_modules/pkg/index.js\0").files).toEqual(["node_modules/pkg/index.js"]);
  });
});
