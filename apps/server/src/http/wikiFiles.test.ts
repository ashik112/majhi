import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConfigSections } from "../config/sections.ts";
import { tempDir } from "../testing/fixtures.ts";
import { wikiExportOf } from "../wiki/export.ts";
import { wikiFileRoutes } from "./wikiFiles.ts";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

describe("wiki source files", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  const get = (path: string, who = "acme/web") => app.request(`/api/wiki/${who}/${SHA}/files/${path}`);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    const tasks = join(dir, "tasks");
    const exported = join(tasks, ".wiki", "acme", "web", `src-${SHA}`);
    await mkdir(join(exported, "src"), { recursive: true });
    await mkdir(join(exported, ".github"));
    await mkdir(join(tasks, ".wiki", "globex", "shop", `src-${SHA}`), { recursive: true });
    await writeFile(join(exported, "src", "app.py"), "def create():\n    return 1\n");
    await writeFile(join(exported, ".github", "ci.yml"), "on: push\n");
    await writeFile(join(exported, ".env"), "SECRET=1");
    await writeFile(join(tasks, ".wiki", "globex", "shop", `src-${SHA}`, "secret.txt"), "GLOBEX-ONLY");
    await writeFile(join(dir, "outside.txt"), "OUTSIDE-BODY");
    await symlink(join(dir, "outside.txt"), join(exported, "link.txt"));
    await symlink(join(exported, ".env"), join(exported, "env.txt"));
    await symlink(dir, join(exported, "up"));
    const sections = {
      exists: true,
      orgs: { acme: { name: "Acme" }, globex: { name: "Globex" } },
      accounts: {},
      projects: {
        web: { path: "/Users/owner/web", org: "acme" },
        shop: { path: "/Users/owner/shop", org: "globex" },
      },
      boss: undefined,
    } as unknown as ConfigSections;
    const on = new Set(["acme"]);
    app = new Hono().route(
      "/api/wiki",
      wikiFileRoutes({
        exportOf: wikiExportOf({
          config: { sections: async () => sections },
          enabled: async (org) => on.has(org),
          tasksDir: async () => tasks,
        }),
      }),
    );
  });
  afterEach(() => cleanup());

  it("refuses .., absolute paths, symlinks out of the export and backslashes", async () => {
    for (const path of [
      "%2e%2e/%2e%2e/outside.txt",
      "src/%2e%2e/%2e%2e/outside.txt",
      "%2Fetc/passwd",
      "link.txt",
      "up/outside.txt",
      "src%5Capp.py",
    ]) {
      const res = await get(path);
      expect(res.status, path).not.toBe(200);
      expect(await res.text(), path).not.toContain("OUTSIDE-BODY");
    }
  });
});
