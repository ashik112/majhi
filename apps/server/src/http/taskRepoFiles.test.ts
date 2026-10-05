import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { taskFileRoutes } from "./taskFiles.ts";

describe("task repo files", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  const get = (path: string) => app.request(`/api/tasks/ACM-1/repo/${path}`);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    const source = join(dir, "web-src");
    const worktree = join(dir, "ACM-1", "web");
    const noTree = join(dir, "api-src");
    for (const root of [source, worktree, noTree]) await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(join(source, "SPEC.md"), "from source");
    await writeFile(join(worktree, "SPEC.md"), "from worktree");
    await writeFile(join(noTree, "docs", "a.md"), "api doc");
    await writeFile(join(worktree, ".env"), "SECRET=1");
    await writeFile(join(dir, "outside.txt"), "OUTSIDE");
    await symlink(join(dir, "outside.txt"), join(worktree, "link.txt"));
    await mkdir(join(dir, "other"));
    app = new Hono().route(
      "/api/tasks",
      taskFileRoutes({
        folderOf: () => join(dir, "ACM-1"),
        reposOf: (id) =>
          id === "ACM-1"
            ? [
                { project: "web", source, worktree },
                { project: "api", source: noTree, worktree: join(dir, "ACM-1", "api") },
              ]
            : undefined,
      }),
    );
  });
  afterEach(() => cleanup());

  it("refuses symlink escapes, dot names, other projects and unknown tasks", async () => {
    expect((await get("web/files/link.txt")).status).toBe(403);
    expect((await get("web/files/.env")).status).toBe(403);
    expect([403, 404]).toContain((await get("web/files/%2e%2e/outside.txt")).status);
    expect((await get("other/files/SPEC.md")).status).toBe(404);
    const unknown = await app.request("/api/tasks/ACM-2/repo/web/files/SPEC.md");
    expect(unknown.status).toBe(404);
  });
});
