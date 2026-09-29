import { useSyncExternalStore } from "react";

/**
 * An update in progress. It lives outside React so the "Updating majhi" screen survives the
 * moments the app itself has nothing to show, while the server is being replaced.
 */
export interface UpdateSession {
  /** When the owner pressed Update, as ISO time. The helper's status file is matched against it. */
  startedAt: string;
}

let current: UpdateSession | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function beginUpdateSession(startedAt = new Date().toISOString()): void {
  current = { startedAt };
  emit();
}

export function endUpdateSession(): void {
  current = undefined;
  emit();
}

export function useUpdateSession(): UpdateSession | undefined {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
