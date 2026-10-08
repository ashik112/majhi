import { useSyncExternalStore } from "react";

/** Which conversations the Chats page and the chat bubble show: one state, so both always agree. */
export type KindFilter = "all" | "client" | "agent";

export interface ChatFilter {
  /** `all`, or a workspace id. */
  tab: string;
  kind: KindFilter;
  archived: boolean;
}

const TAB_KEY = "majhi.chatsTab";

function readTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? "all";
  } catch {
    return "all";
  }
}

let state: ChatFilter = { tab: readTab(), kind: "all", archived: false };
const listeners = new Set<() => void>();

/** Changes part of the filter. The last workspace tab is remembered in this browser. */
export function setChatFilter(patch: Partial<ChatFilter>): void {
  state = { ...state, ...patch };
  if (patch.tab !== undefined) {
    try {
      localStorage.setItem(TAB_KEY, patch.tab);
    } catch {
      // Storage blocked: the tab is kept until the page reloads.
    }
  }
  for (const listener of listeners) listener();
}

export function useChatFilter(): ChatFilter {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
