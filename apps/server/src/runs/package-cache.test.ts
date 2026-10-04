import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";
import { cacheEnv, cacheRoot, packageCache } from "./package-cache.ts";

let w: World | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe("a workspace's package store", () => {
  it("keeps two workspaces apart: each gets its own folder, and every variable points inside it", async () => {
    const { dir, cleanup } = await tempDir();
    try {
      const acme = await packageCache(dir, { org: "acme" });
      const globex = await packageCache(dir, { org: "globex" });
      const priv = await packageCache(dir, {});
      expect(acme.mounts).toEqual([{ path: join(dir, "cache", "acme") }]);
      expect(globex.mounts).toEqual([{ path: join(dir, "cache", "globex") }]);
      expect(priv.mounts).toEqual([{ path: join(dir, "cache", "private") }]);
      for (const [org, got] of [
        ["acme", acme],
        ["globex", globex],
      ] as const) {
        for (const value of Object.values(got.env)) {
          expect(value.startsWith(`${join(dir, "cache", org)}/`), value).toBe(true);
        }
      }
    } finally {
      await cleanup();
    }
  });

  it("points pnpm, npm, yarn and pip at the store", () => {
    expect(cacheEnv("/Users/owner/.majhi/cache/acme")).toEqual({
      npm_config_store_dir: "/Users/owner/.majhi/cache/acme/pnpm-store",
      PNPM_STORE_DIR: "/Users/owner/.majhi/cache/acme/pnpm-store",
      npm_config_cache: "/Users/owner/.majhi/cache/acme/npm",
      YARN_CACHE_FOLDER: "/Users/owner/.majhi/cache/acme/yarn",
      PIP_CACHE_DIR: "/Users/owner/.majhi/cache/acme/pip",
    });
  });

  it("refuses a workspace id that would leave the cache folder", () => {
    for (const org of ["../globex", "acme/../globex", "", "A", "/etc"]) {
      expect(() => cacheRoot("/Users/owner/.majhi", org), org).toThrow();
    }
  });

  it("reaches a run as its mount and variables, and brings nothing of majhi's own environment", async () => {
    vi.stubEnv("MAJHI_PROBE_SECRET", "leak-me");
    vi.stubEnv("npm_config_store_dir", "/host/store");
    w = await taskWorld();
    const { h } = w;
    const created = await h.cmd("tasks.create", {
      text: "fix api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(created.status).toBe(200);
    await until(() => h.runtime.starts.length > 0, "the run to start");
    const start = h.runtime.starts[0];
    const own = join(h.env.majhiHome, "cache", "acme");
    expect(start?.mounts).toContainEqual({ path: own });
    expect((start?.mounts ?? []).filter((m) => m.path.includes("/cache/"))).toEqual([{ path: own }]);
    expect(start?.env).toEqual({ ...cacheEnv(own), MAJHI_TOOLS: join(h.env.majhiHome, "tools", "acme") });
    expect(JSON.stringify(start?.env)).not.toContain("leak-me");
    expect(JSON.stringify(start?.env)).not.toContain("/host/store");
  });
});
