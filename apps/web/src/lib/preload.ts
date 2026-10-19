/**
 * Reads the code of what opens on a key or a click (the palette, the New task dialog, the shortcuts list,
 * the drawers) once the first screen is up, so a press never waits for a chunk. The controls set their
 * open state at once and show the dialog when its chunk arrives; this only makes that moment nearly
 * always zero. A failed read is ignored: the control then loads the chunk itself.
 */
export function preloadOpenOnDemand(): void {
  const load = () => {
    const reads: (() => Promise<unknown>)[] = [
      () => import("@/features/new-task/new-task-dialog"),
      () => import("@/features/search/palette"),
      () => import("@/components/shell/shortcuts-dialog"),
      () => import("@/features/task-drawer/task-drawer"),
      () => import("@/features/agent-drawer/agent-drawer"),
    ];
    for (const read of reads) read().catch(() => undefined);
  };
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(load, { timeout: 1500 });
  else globalThis.setTimeout(load, 300);
}
