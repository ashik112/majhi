import { describe, expect, it } from "vitest";
import { FILE_CACHE_MS, FileIndex, MAX_FILE_RESULTS, scoreMatch } from "./files.ts";

const repos = (...projects: string[]) => ({
  repos: projects.map((p) => ({
    project: p,
    source: "/s",
    base: "main",
    branch: "b",
    worktree: `/t/${p}`,
    createdBranch: true,
  })),
});

describe("scoreMatch", () => {
  it("ranks exact name, name prefix, name part, path part, then loose matches", () => {
    const scores = ["a/health.ts", "a/health-check.ts", "a/x-health.ts", "health/x.ts", "a/hlth.ts"].map(
      (p) => scoreMatch(p, p === "a/hlth.ts" ? "hlth" : "health") ?? 99,
    );
    expect(scores).toEqual([1, 1, 2, 3, 1]);
    expect(scoreMatch("src/a/health.ts", "health.ts")).toBe(0);
    expect(scoreMatch("src/HealthCheck.ts", "hk")).toBe(4);
    expect(scoreMatch("src/health/check.ts", "shc")).toBe(5);
    expect(scoreMatch("src/a.ts", "zzz")).toBeUndefined();
  });
});

describe("FileIndex", () => {
  const lists: Record<string, string[]> = {
    "/t/api": ["README.md", "src/index.ts", "src/routes/health.ts", "src/routes/health.test.ts"],
    "/t/web": ["src/App.tsx", "src/health-panel.tsx"],
  };

  it("finds files across worktrees, best match first, paths relative to the task folder", async () => {
    const index = new FileIndex(Date.now, async (cwd) => lists[cwd] ?? []);
    expect(await index.search(repos("api", "web"), "health")).toEqual([
      { path: "api/src/routes/health.ts", repo: "api" },
      { path: "web/src/health-panel.tsx", repo: "web" },
      { path: "api/src/routes/health.test.ts", repo: "api" },
    ]);
    expect(await index.search(repos("api"), "READ")).toEqual([{ path: "api/README.md", repo: "api" }]);
  });

  it("returns at most 50, and reuses a listing for a few seconds", async () => {
    let calls = 0;
    let now = 1000;
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`);
    const index = new FileIndex(
      () => now,
      async () => {
        calls++;
        return many;
      },
    );
    expect(await index.search(repos("api"), "")).toHaveLength(MAX_FILE_RESULTS);
    await index.search(repos("api"), "f1");
    expect(calls).toBe(1);
    now += FILE_CACHE_MS + 1;
    await index.search(repos("api"), "f1");
    expect(calls).toBe(2);
  });

  it("skips worktrees that do not exist yet and ones that fail", async () => {
    const index = new FileIndex(Date.now, async () => {
      throw new Error("gone");
    });
    expect(await index.search(repos("api"), "x")).toEqual([]);
    expect(
      await index.search(
        { repos: [{ project: "api", source: "/s", base: "m", branch: "b", createdBranch: true }] },
        "x",
      ),
    ).toEqual([]);
  });
});
