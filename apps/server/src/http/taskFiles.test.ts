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

  it("serves handoff notes, and nothing else hidden, not even through a note's name", async () => {
    const folder = join(dir, "ACM-1");
    await mkdir(join(folder, ".handoffs", "deeper"), { recursive: true });
    await writeFile(join(folder, ".handoffs", "acme-builder-2.md"), "## Next step\n");
    await writeFile(join(folder, ".handoffs", "notes.txt"), "x");
    await writeFile(join(folder, ".handoffs", "deeper", "a-1.md"), "x");
    await symlink(join(folder, ".env"), join(folder, ".handoffs", "sneaky-1.md"));
    await symlink(join(dir, "outside.txt"), join(folder, ".handoffs", "outside-1.md"));
    const ok = await get(".handoffs/acme-builder-2.md");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("## Next step\n");
    for (const path of [
      ".handoffs/notes.txt",
      ".handoffs/deeper/a-1.md",
      ".handoffs/sneaky-1.md",
      ".handoffs/outside-1.md",
      ".handoffs/..%2F.env",
      ".git/config",
    ]) {
      expect((await get(path)).status, path).not.toBe(200);
    }
  });

  it("serves a check's step logs, and nothing else under .checks, not even through a link", async () => {
    const folder = join(dir, "ACM-1");
    await mkdir(join(folder, ".checks", "mux3yqk1-a02329", "home"), { recursive: true });
    await writeFile(join(folder, ".checks", "mux3yqk1-a02329", "tests.log"), "FAIL one\n");
    await writeFile(join(folder, ".checks", "mux3yqk1-a02329", "home", "secret.log"), "x");
    await writeFile(join(folder, ".checks", "mux3yqk1-a02329", "notes.log"), "x");
    await symlink(join(dir, "outside.txt"), join(folder, ".checks", "mux3yqk1-a02329", "lint.log"));
    const ok = await get(".checks/mux3yqk1-a02329/tests.log");
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("FAIL one\n");
    for (const path of [
      ".checks/mux3yqk1-a02329/home/secret.log",
      ".checks/mux3yqk1-a02329/notes.log",
      ".checks/mux3yqk1-a02329/lint.log",
      ".checks/mux3yqk1-a02329",
      ".checks/..%2F.env",
    ]) {
      expect((await get(path)).status, path).not.toBe(200);
    }
  });

  it("sandboxes pages and svg, and downloads unknown types", async () => {
    const csp = "sandbox allow-scripts allow-forms allow-popups allow-downloads";
    const page = await get("media/report.html");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toBe(csp);
    expect((await get("media/drawing.svg")).headers.get("content-security-policy")).toBe(csp);
    const bin = await get("media/data.bin");
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    expect(bin.headers.get("content-disposition")).toBe("attachment");
  });

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
