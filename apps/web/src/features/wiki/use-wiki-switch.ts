import { type OrgView, PRIVATE, resolveWikiEnabled } from "@majhi/shared";
import { useMemo } from "react";
import { wikiChoice } from "@/features/orgs/model";
import { useSettings } from "@/lib/boss-queries";
import { useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";

/** One workspace as the wiki page and its settings see it. */
export interface WikiWorkspace {
  org: OrgView;
  /** What the workspace's own setting says: unset follows majhi's. */
  choice: "default" | "on" | "off";
  /** Whether the wiki is on there, after the default is applied. */
  enabled: boolean;
}

/** Every workspace with its wiki switch resolved the way the server does (`resolveWikiEnabled`). Empty until both reads arrive. */
export function useWikiWorkspaces(): { workspaces: WikiWorkspace[]; globalOn: boolean | undefined } {
  const orgs = useOrgs().data;
  const settings = useSettings().data;
  return useMemo(() => {
    const globalOn = settings?.wiki.enabled;
    if (orgs === undefined || globalOn === undefined) return { workspaces: [], globalOn };
    const list = [...orgs.filter((o) => o.id === PRIVATE), ...orgs.filter((o) => o.id !== PRIVATE)];
    return {
      globalOn,
      workspaces: list.map((org) => ({
        org,
        choice: wikiChoice(org),
        enabled: resolveWikiEnabled({ org: org.wiki, global: { enabled: globalOn } }),
      })),
    };
  }, [orgs, settings]);
}

/** Whether the sidebar lists Wiki: the workspace picked in the sidebar has it on, or, with All, any workspace does. */
export function useWikiInSidebar(): boolean {
  const { org } = useOrgFilter();
  const { workspaces } = useWikiWorkspaces();
  return workspaces.some((w) => (org === undefined || w.org.id === org) && w.enabled);
}
