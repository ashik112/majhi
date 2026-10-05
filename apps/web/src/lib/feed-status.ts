import { useSyncExternalStore } from "react";

/** Whether the events socket is open. Undefined until it has tried once. */
let open: boolean | undefined;
const listeners = new Set<() => void>();

export function setFeedOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** True while the events socket is open: the first sign that the server is there, so `/health` is asked only now and then. */
export function useFeedOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open === true);
}

/** How often `/health` is asked while the socket is down (the pill must show a lost server fast) and while it is up (a safety net). */
export function healthEveryMs(feedOpen: boolean): number {
  return feedOpen ? 30_000 : 1500;
}
