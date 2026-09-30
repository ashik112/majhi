import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readModelCatalog } from "./model-catalog.ts";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function home(file?: string, content?: string): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "majhi-catalog-"));
  if (file !== undefined && content !== undefined) await writeFile(join(dir, file), content);
  return dir;
}

/** The shape of the list Codex ships and caches: a slug, and `upgrade` set on a replaced model. */
const CATALOG = {
  fetched_at: "2026-09-30T00:00:00Z",
  models: [
    { slug: "gpt-6-sol", upgrade: null, visibility: "list", priority: 2, supported_reasoning_levels: [] },
    { slug: "gpt-6-luna", upgrade: null, visibility: "list" },
    { slug: "gpt-5.6-sol", upgrade: { model: "gpt-6-sol", migration_markdown: "Use gpt-6-sol." } },
    { slug: "gpt-5.6-luna", upgrade: { model: "gpt-6-luna" } },
    { slug: "gpt-5.5", upgrade: { model: "gpt-6-sol" }, extra: [1, 2, 3] },
  ],
};

describe("readModelCatalog", () => {
  it("maps a replaced model to its replacement, and skips models that were not replaced", async () => {
    const h = await home("models_cache.json", JSON.stringify(CATALOG));
    const out = await readModelCatalog(h, "models_cache.json");
    expect([...out.entries()].sort()).toEqual([
      ["gpt-5.5", "gpt-6-sol"],
      ["gpt-5.6-luna", "gpt-6-luna"],
      ["gpt-5.6-sol", "gpt-6-sol"],
    ]);
  });

  it("accepts `id` for `slug` and a plain string for `upgrade`", async () => {
    const h = await home("c.json", JSON.stringify({ models: [{ id: "old-1", upgrade: "new-1" }] }));
    expect([...(await readModelCatalog(h, "c.json"))]).toEqual([["old-1", "new-1"]]);
  });

  it("ignores entries it cannot read and keeps the rest", async () => {
    const h = await home(
      "c.json",
      JSON.stringify({
        models: [
          null,
          5,
          { slug: 7 },
          { slug: "a-1", upgrade: { model: 3 } },
          { slug: "b-1", upgrade: { model: "b-2" } },
        ],
      }),
    );
    expect([...(await readModelCatalog(h, "c.json"))]).toEqual([["b-1", "b-2"]]);
  });

  it("never throws: no file, bad JSON, wrong shape, no catalog for the tool", async () => {
    expect((await readModelCatalog(await home(), "models_cache.json")).size).toBe(0);
    expect((await readModelCatalog(await home("c.json", "{ not json"), "c.json")).size).toBe(0);
    expect((await readModelCatalog(await home("c.json", '{"models": "x"}'), "c.json")).size).toBe(0);
    expect((await readModelCatalog(await home("c.json", "[]"), "c.json")).size).toBe(0);
    expect((await readModelCatalog(await home("c.json", JSON.stringify(CATALOG)), undefined)).size).toBe(0);
  });
});
