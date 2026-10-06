import { join } from "node:path";
import { IdSchema } from "@majhi/shared";

/**
 * Where a project's rebuildable wiki files live: the clean source export and the fact files
 * (`<tasks_dir>/.wiki/<org>/<project>/`), beside the tasks folder like the code graph, never in majhi's config.
 * Both ids are checked as ids, so neither can name a parent folder.
 */
export function wikiCacheDir(tasksDir: string, org: string, project: string): string {
  return join(tasksDir, ".wiki", IdSchema.parse(org), IdSchema.parse(project));
}
