import type { CaptainOrg, RoomItem } from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import type { PanelTab } from "@/features/boss/boss-context";

/** The workspaces that have a thread, in the order of the workspaces. */
export function threadsOf(orgs: readonly CaptainOrg[]): CaptainOrg[] {
  return orgs.filter((o) => o.lane !== undefined);
}

export type ThreadState = CaptainOrg["thread"];

export const THREAD_LAMP: Record<ThreadState, LampState> = {
  working: "working",
  waiting: "needs",
  idle: "idle",
};

export const THREAD_WORD: Record<ThreadState, string> = {
  working: "Working",
  waiting: "Waiting on you",
  idle: "Idle",
};

/** The tab id of a workspace's thread, and the workspace of a tab id. */
export const wsTab = (org: string): PanelTab => `ws:${org}`;
export function orgOfTab(tab: PanelTab): string | undefined {
  return tab.startsWith("ws:") ? tab.slice(3) : undefined;
}

/**
 * The tab to show: the asked one when it exists, else Talk. A workspace tab goes when its thread
 * does (a workspace removed), and the panel falls back instead of showing nothing.
 */
export function validTab(tab: PanelTab, threads: readonly CaptainOrg[]): PanelTab {
  const org = orgOfTab(tab);
  if (org === undefined) return tab;
  return threads.some((t) => t.org === org) ? tab : "talk";
}

/** The next tab for an arrow key, wrapping around. */
export function stepTab(tabs: readonly PanelTab[], current: PanelTab, key: string): PanelTab | undefined {
  const at = tabs.indexOf(current);
  if (at < 0 || tabs.length === 0) return undefined;
  switch (key) {
    case "ArrowRight":
      return tabs[(at + 1) % tabs.length];
    case "ArrowLeft":
      return tabs[(at - 1 + tabs.length) % tabs.length];
    case "Home":
      return tabs[0];
    case "End":
      return tabs.at(-1);
    default:
      return undefined;
  }
}

/** One line of the merged timeline: who spoke in which workspace's thread. */
export interface MergedLine {
  key: string;
  org: string;
  at: string;
  who: "You" | "Captain";
  text: string;
}

/** The owner's and the captain's messages of several threads, newest first, cut to `limit`. */
export function mergeThreads(
  threads: readonly { org: string; items: readonly RoomItem[] }[],
  limit = 60,
): MergedLine[] {
  const lines: MergedLine[] = [];
  for (const thread of threads) {
    for (const item of thread.items) {
      if (item.type === "owner" && item.removed !== true && item.text.trim() !== "") {
        lines.push({
          key: `${thread.org}:${item.id}`,
          org: thread.org,
          at: item.at,
          who: "You",
          text: item.text,
        });
      } else if (item.type === "agent" && item.text.trim() !== "") {
        lines.push({
          key: `${thread.org}:${item.id}`,
          org: thread.org,
          at: item.at,
          who: "Captain",
          text: item.text,
        });
      }
    }
  }
  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}
