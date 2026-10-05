import type { Store } from "../store/index.ts";

/**
 * Puts a task row in a state for a test, with no transition, no audit row and no effects. Tests that
 * check the lifecycle itself go through `apply`; this is only to set the scene.
 */
export function seedStatus(
  store: Store,
  id: string,
  status: string,
  pausedReason?: string,
  at = new Date().toISOString(),
  pausedBy?: string,
): void {
  store.raw
    .prepare("UPDATE tasks SET status = ?, paused_reason = ?, paused_by = ?, updated_at = ? WHERE id = ?")
    .run(status, pausedReason ?? null, pausedBy ?? null, at, id);
}
