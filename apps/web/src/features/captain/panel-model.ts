import type { CaptainOrg } from "@majhi/shared";
import type { PanelTab } from "@/features/boss/boss-context";

/** The workspaces that have a thread, in the order of the workspaces. */
export function threadsOf(orgs: readonly CaptainOrg[]): CaptainOrg[] {
  return orgs.filter((o) => o.lane !== undefined);
}

/** The tab id of a workspace's thread, and the workspace of a tab id. */
export const wsTab = (org: string): PanelTab => `ws:${org}`;
export function orgOfTab(tab: PanelTab): string | undefined {
  return tab.startsWith("ws:") ? tab.slice(3) : undefined;
}

/**
 * The tab to show: the asked one when it exists, else the owner's own chat. "All" is that chat too:
 * there is one conversation surface. A workspace tab goes when its thread does (a workspace removed),
 * and the panel falls back instead of showing nothing.
 */
export function validTab(tab: PanelTab, threads: readonly CaptainOrg[]): PanelTab {
  const org = orgOfTab(tab);
  if (org === undefined) return "talk";
  return threads.some((t) => t.org === org) ? tab : "talk";
}

/** What waits in a thread, for the chip's tooltip. */
export function waitingWord(org: Pick<CaptainOrg, "name" | "forYou">): string {
  return org.forYou > 0
    ? `${org.name}: ${org.forYou} ${org.forYou === 1 ? "thing" : "things"} waiting on you`
    : `${org.name}: waiting on you`;
}
