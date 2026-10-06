import { stat } from "node:fs/promises";
import { join } from "node:path";
import { PRIVATE } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { wikiCacheDir } from "./paths.ts";
import type { WikiEnabled } from "./switch.ts";

export interface WikiExportDeps {
  config: Pick<ConfigService, "sections">;
  enabled: WikiEnabled;
  tasksDir: () => Promise<string>;
}

/**
 * Where the clean export of a project's source at one commit lives, for the file route. It answers only for
 * a project the workspace owns, while its wiki is on, and for a commit that was exported
 * (`<tasks_dir>/.wiki/<org>/<project>/src-<commit>/`). Anything else is undefined.
 */
export function wikiExportOf(deps: WikiExportDeps) {
  return async (org: string, project: string, commit: string): Promise<string | undefined> => {
    const sections = await deps.config.sections();
    const owned = sections.projects[project];
    if (owned === undefined || (owned.org ?? PRIVATE) !== org || sections.orgs[org] === undefined) {
      return undefined;
    }
    if (!(await deps.enabled(org))) return undefined;
    const dir = join(wikiCacheDir(await deps.tasksDir(), org, project), `src-${commit}`);
    return (await stat(dir).catch(() => undefined))?.isDirectory() ? dir : undefined;
  };
}
