import type { PendingNotice } from "@majhi/shared";
import { useQuery } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { type ApiRequestError, cmd } from "./api";
import { queryKeys } from "./queries";

/**
 * What waits for the owner in open tasks and chats, one row per item. Under `tasks`, so every task
 * change (an item asked or answered) refetches it with the task list it goes with.
 */
export function usePendingNotices() {
  return useQuery<PendingNotice[], ApiRequestError>({
    queryKey: [...queryKeys.tasks, "notices"],
    queryFn: () => cmd("notify.pending", {}),
  });
}

/** Whether the notifications panel is open. The bell opens it, and so does the banner's "more". */
let open = false;
const listeners = new Set<() => void>();

export function setNoticesOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export function useNoticesOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => open,
  );
}
