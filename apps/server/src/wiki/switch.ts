import { resolveWikiEnabled } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";

/** Whether a workspace has a project wiki: its own setting, else majhi's, else off. Read each time, so a change applies at once. */
export type WikiEnabled = (org: string) => Promise<boolean>;

export function wikiEnabledFrom(config: Pick<ConfigService, "settings" | "sections">): WikiEnabled {
  return async (org) => {
    const [settings, sections] = await Promise.all([config.settings(), config.sections()]);
    return resolveWikiEnabled({ org: sections.orgs[org]?.wiki, global: settings.wiki });
  };
}
