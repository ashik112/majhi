import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_SUGGESTIONS, suggestRoots } from "./suggestRoots.ts";

describe("suggestRoots", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "majhi-host-test-")));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const repos = (...paths: string[]) =>
    Promise.all(paths.map((p) => mkdir(join(home, p, ".git"), { recursive: true })));

  it("counts repos per first-level folder of home, most first, with the scanner's rules", async () => {
    await repos(
      "Work/a",
      "Work/b",
      "Work/team/c",
      "Work/a/nested", // inside a repo: not counted
      "Work/x/node_modules/dep", // node_modules: skipped
      "Work/.cache/hidden", // hidden: skipped
      "Work/1/2/3/4", // level 4: counted
      "Work/1/2/3/4b/5", // level 5: too deep
      "Projects/one",
      "Library/Caches/tool", // Library: never suggested
      "Pictures/album", // media folders: never suggested
      "OrbStack/docker/volumes/v", // OrbStack machines: never suggested
      ".dotfiles/repo", // hidden at home: skipped
    );
    await mkdir(join(home, "Empty"));
    await mkdir(join(home, "Work", "wt"));
    await writeFile(join(home, "Work", "wt", ".git"), "gitdir: /elsewhere\n");
    await symlink(join(home, "Work"), join(home, "WorkLink"));

    expect(await suggestRoots(home)).toEqual([
      { path: join(home, "Work"), repoCount: 4 },
      { path: join(home, "Projects"), repoCount: 1 },
    ]);
  });

  it("counts a first-level folder that is itself a repo", async () => {
    await repos("dotnet-app");
    expect(await suggestRoots(home)).toEqual([{ path: join(home, "dotnet-app"), repoCount: 1 }]);
  });

  it(`returns at most ${MAX_SUGGESTIONS}, breaking ties by path`, async () => {
    await repos(...["h", "g", "f", "e", "d", "c", "b"].map((n) => `${n}/repo`), "a/r1", "a/r2");
    const suggestions = await suggestRoots(home);
    expect(suggestions.map((s) => [s.path.slice(home.length + 1), s.repoCount])).toEqual([
      ["a", 2],
      ["b", 1],
      ["c", 1],
      ["d", 1],
      ["e", 1],
      ["f", 1],
    ]);
  });

  it("stops at the folder budget, looking at every candidate before going deeper", async () => {
    // A deep, wide folder that sorts first must not use up the budget before Work is looked at.
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => mkdir(join(home, "Aaa", `d${i}`, "deeper"), { recursive: true })),
    );
    await repos("Aaa/d0/deeper/late", "Work/api", "Work/web");

    // 2 candidates (level 0), then their 32 children (level 1), then the budget runs out.
    const suggestions = await suggestRoots(home, { ms: 10_000, dirs: 34 });
    expect(suggestions).toEqual([{ path: join(home, "Work"), repoCount: 2 }]);

    expect(await suggestRoots(home)).toEqual([
      { path: join(home, "Work"), repoCount: 2 },
      { path: join(home, "Aaa"), repoCount: 1 },
    ]);
  });

  it("returns what it counted when the time budget runs out", async () => {
    await repos("Work/api");
    const started = Date.now();
    const suggestions = await suggestRoots(home, { ms: 0, dirs: 20_000 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(suggestions.every((s) => s.path === join(home, "Work") && s.repoCount <= 1)).toBe(true);
  });
});
