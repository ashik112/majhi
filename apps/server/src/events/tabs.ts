/** A tab's report counts this long: three missed reports (every 20 s) and it no longer does. */
export const TAB_FRESH_MS = 60_000;

/**
 * Which open tabs can pop a browser notification, from what they report on `/api/events`. The
 * notifier skips the desktop banner while one can, since that tab already tells the owner and its
 * click focuses majhi. Keyed by socket; a closed socket is dropped at once, a silent one after
 * `TAB_FRESH_MS`.
 */
export class BrowserTabs {
  /** Socket to the time of its last "active" report. */
  private readonly active = new Map<object, number>();

  report(tab: object, active: boolean, now: number): void {
    if (active) this.active.set(tab, now);
    else this.active.delete(tab);
  }

  drop(tab: object): void {
    this.active.delete(tab);
  }

  /** True while a tab reported "active" within the last `TAB_FRESH_MS`. */
  popping(now: number): boolean {
    for (const [tab, at] of this.active) {
      if (now - at < TAB_FRESH_MS) return true;
      this.active.delete(tab);
    }
    return false;
  }
}
