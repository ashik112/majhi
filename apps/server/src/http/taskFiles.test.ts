import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { taskFileRoutes } from "./taskFiles.ts";

describe("task files", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`/api/tasks/ACM-1/files/${path}`, { headers });

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    const folder = join(dir, "ACM-1");
    await mkdir(join(folder, "media"), { recursive: true });
    await mkdir(join(folder, ".git"));
    await writeFile(join(folder, "TASK.md"), "# ACM-1\n");
    await writeFile(join(folder, "media", "chart.png"), Buffer.from("0123456789"));
    await writeFile(join(folder, "media", "report.html"), "<script>1</script>");
    await writeFile(join(folder, "media", "drawing.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    await writeFile(join(folder, "media", "data.bin"), "x");
    await writeFile(join(folder, ".env"), "SECRET=1");
    await writeFile(join(folder, ".git", "config"), "[core]");
    await writeFile(join(dir, "outside.txt"), "OUTSIDE-BODY");
    await symlink(join(dir, "outside.txt"), join(folder, "link.txt"));
    await symlink(dir, join(folder, "up"));
    await symlink(join(folder, ".env"), join(folder, "env.txt"));
    app = new Hono().route(
      "/api/tasks",
      taskFileRoutes({ folderOf: (id) => (id === "ACM-1" ? folder : undefined) }),
    );
  });
  afterEach(() => cleanup());

  it("refuses dot names, escapes and symlinks that leave the folder", async () => {
    for (const path of [
      ".env",
      ".git/config",
      "%2eenv",
      "media/%2e%2e/.env",
      "media/..%2f.env",
      "media/../../outside.txt",
      "..%2foutside.txt",
      "link.txt",
      "up/outside.txt",
      "env.txt",
    ]) {
      const res = await get(path);
      expect([403, 404], path).toContain(res.status);
      const body = await res.text();
      expect(body, path).not.toContain("SECRET");
      expect(body, path).not.toContain("OUTSIDE-BODY");
    }
    expect((await get(".env")).status).toBe(403);
    expect((await get("link.txt")).status).toBe(403);
  });
});
