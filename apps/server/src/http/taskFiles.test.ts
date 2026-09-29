import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { parseRange, taskFileRoutes } from "./taskFiles.ts";

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

  it("answers size and modified time for ?meta=1, under the same rules", async () => {
    const res = await get("media/chart.png?meta=1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { size: number; modified: string };
    expect(body.size).toBe(10);
    expect(Number.isNaN(Date.parse(body.modified))).toBe(false);
    expect((await get(".env?meta=1")).status).toBe(403);
    expect((await get("link.txt?meta=1")).status).toBe(403);
    expect((await get("up/outside.txt?meta=1")).status).toBe(403);
    expect((await get("media/missing.png?meta=1")).status).toBe(404);
    expect((await get("media?meta=1")).status).toBe(404);
  });

  it("serves a file with its type, no sniffing and no caching", async () => {
    const res = await get("media/chart.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(await res.text()).toBe("0123456789");
    expect((await get("TASK.md")).headers.get("content-type")).toBe("text/plain; charset=utf-8");
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

  it("answers ranges for video and audio", async () => {
    const part = await get("media/chart.png", { range: "bytes=2-4" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(part.headers.get("content-length")).toBe("3");
    expect(await part.text()).toBe("234");
    expect(await (await get("media/chart.png", { range: "bytes=7-" })).text()).toBe("789");
    expect(await (await get("media/chart.png", { range: "bytes=-2" })).text()).toBe("89");
    const bad = await get("media/chart.png", { range: "bytes=50-60" });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */10");
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

  it("answers 404 for a missing file, a folder, an unknown task and a bad id", async () => {
    expect((await get("nope.png")).status).toBe(404);
    expect((await get("media")).status).toBe(404);
    expect((await app.request("/api/tasks/ACM-2/files/TASK.md")).status).toBe(404);
    expect((await app.request("/api/tasks/x/files/TASK.md")).status).toBe(404);
    expect((await get("%E0%A4%A")).status).toBe(404);
  });
});

describe("parseRange", () => {
  it("reads one range and ignores the rest", () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange("bytes=0-", 10)).toEqual([0, 9]);
    expect(parseRange("bytes=3-99", 10)).toEqual([3, 9]);
    expect(parseRange("bytes=-3", 10)).toEqual([7, 9]);
    expect(parseRange("bytes=9-3", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,4-5", 10)).toBeUndefined();
    expect(parseRange("items=0-1", 10)).toBeUndefined();
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });
});
