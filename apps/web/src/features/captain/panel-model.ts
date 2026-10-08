import type { CaptainOrg } from "@majhi/shared";
import type { PanelTab } from "@/features/boss/boss-context";

/**
 * Every workspace is a place to talk to the captain, in the order of the workspaces. A thread is made
 * by the owner's first message there; until then the chip opens an empty one.
 */
export function threadsOf(orgs: readonly CaptainOrg[]): CaptainOrg[] {
  return [...orgs];
}

/** The tab id of a workspace's thread, and the workspace of a tab id. */
export const wsTab = (org: string): PanelTab => `ws:${org}`;
/** The tab of a workspace's Urgent thread: the same captain's on-call lane. */
export const urgentTab = (org: string): PanelTab => `urgent:${org}`;
export function orgOfTab(tab: PanelTab): string | undefined {
  if (tab.startsWith("ws:")) return tab.slice(3);
  return tab.startsWith("urgent:") ? tab.slice(7) : undefined;
}
export const isUrgentTab = (tab: PanelTab): boolean => tab.startsWith("urgent:");

/**
 * The tab to show: the asked one when it exists, else the owner's own chat. "All" is that chat too:
 * there is one conversation surface. A workspace tab goes when its thread does (a workspace removed),
 * and the panel falls back instead of showing nothing.
 */
export function validTab(tab: PanelTab, threads: readonly CaptainOrg[]): PanelTab {
  const org = orgOfTab(tab);
  if (org === undefined) return "talk";
  const found = threads.find((t) => t.org === org);
  if (found === undefined) return "talk";
  // An Urgent tab goes back to Main when the workspace has no Urgent thread.
  return isUrgentTab(tab) && found.onCall === undefined ? wsTab(found.org) : tab;
}

/** What waits in a thread, for the chip's tooltip. */
export function waitingWord(org: Pick<CaptainOrg, "name" | "forYou">): string {
  return org.forYou > 0
    ? `${org.name}: ${org.forYou} ${org.forYou === 1 ? "needs" : "need"} you`
    : `${org.name}: waiting on you`;
}
