import { useSyncExternalStore } from "react";
import type { PendingPermission } from "@/features/shell/model";

/**
 * The permission prompt waiting in the task the owner has open, published by that task's room so the
 * shell's banner can point at it. Only the open room has a live socket, so only it is known.
 */
let current: PendingPermission | undefined;
const listeners = new Set<() => void>();

export function setPendingPermission(next: PendingPermission | undefined): void {
  if (current?.elementId === next?.elementId && current?.task === next?.task) return;
  current = next;
  for (const listener of listeners) listener();
}

export function usePendingPermission(): PendingPermission | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
