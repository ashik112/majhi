/** A typing report counts this long: the tab repeats it every 5 s, so three missed reports end it. */
export const TYPING_FRESH_MS = 15_000;

/**
 * Which tasks the owner is typing in right now, from what open tabs report on `/api/events` (SPEC
 * 5.18, Presence). Keyed by socket: a closed socket is dropped at once, a silent one after
 * `TYPING_FRESH_MS`. The captain asks `holds(task)`; a task it had to wait on is remembered, and
 * `onIdle` fires once nobody types in it any more, so the captain tries again then.
 */
export class OwnerTyping {
  /** Socket to the task it types in and when it last said so. */
  private readonly tabs = new Map<object, { task: string; at: number }>();
  /** Tasks the captain waited on and has not been told about since. */
  private readonly waited = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listener: ((task: string) => void) | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  onIdle(listener: (task: string) => void): void {
    this.listener = listener;
  }

  /** A tab types in `task`, or stopped typing (`task` undefined). */
  report(tab: object, task: string | undefined): void {
    const before = this.tabs.get(tab)?.task;
    if (task === undefined) this.tabs.delete(tab);
    else {
      this.tabs.set(tab, { task, at: this.now() });
      this.watch(task);
    }
    if (before !== undefined && before !== task) this.settle(before);
  }

  drop(tab: object): void {
    const before = this.tabs.get(tab)?.task;
    this.tabs.delete(tab);
    if (before !== undefined) this.settle(before);
  }

  /** True while a tab reported typing in `task` within `TYPING_FRESH_MS`. Remembers that the captain waited. */
  holds(task: string): boolean {
    const typing = this.typing(task);
    if (typing) this.waited.add(task);
    return typing;
  }

  private typing(task: string): boolean {
    const now = this.now();
    for (const [tab, t] of this.tabs) {
      if (now - t.at >= TYPING_FRESH_MS) this.tabs.delete(tab);
      else if (t.task === task) return true;
    }
    return false;
  }

  /** Checks once the reports of `task` can have run out. */
  private watch(task: string): void {
    clearTimeout(this.timers.get(task));
    const timer = setTimeout(() => this.settle(task), TYPING_FRESH_MS + 100);
    timer.unref();
    this.timers.set(task, timer);
  }

  private settle(task: string): void {
    if (this.typing(task)) return;
    clearTimeout(this.timers.get(task));
    this.timers.delete(task);
    if (this.waited.delete(task)) this.listener?.(task);
  }
}
