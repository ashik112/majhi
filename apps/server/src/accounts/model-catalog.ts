import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The model list a CLI caches under the account's config home, as far as majhi needs it: which
 * model has been replaced by which. Every field is read tolerantly, because the file belongs to
 * the CLI and may change shape or carry more keys.
 */
const CatalogSchema = z.looseObject({
  models: z.array(z.unknown()),
});

const ModelSchema = z.looseObject({
  slug: z.string().optional(),
  id: z.string().optional(),
  upgrade: z.union([z.string(), z.looseObject({ model: z.string().optional() })]).nullish(),
});

/** Model id to the id of the model that replaced it. Empty when the file is missing or unreadable. Never throws. */
export async function readModelCatalog(home: string, file: string | undefined): Promise<Map<string, string>> {
  const replaced = new Map<string, string>();
  if (file === undefined) return replaced;
  try {
    const catalog = CatalogSchema.safeParse(JSON.parse(await readFile(join(home, file), "utf8")));
    if (!catalog.success) return replaced;
    for (const raw of catalog.data.models) {
      const model = ModelSchema.safeParse(raw);
      if (!model.success) continue;
      const id = model.data.slug ?? model.data.id;
      const upgrade = model.data.upgrade;
      const by = typeof upgrade === "string" ? upgrade : upgrade?.model;
      if (id !== undefined && by !== undefined && by !== "" && by !== id) replaced.set(id, by);
    }
  } catch {
    // A missing or half-written file is not an error: the models are simply not marked.
  }
  return replaced;
}
