import { useCallback, useSyncExternalStore } from "react";

/** One timer per interval length, shared by every component that asks, so a board of cards runs one clock, not one per card. */
interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: number | undefined;
}
const clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let clock = clocks.get(intervalMs);
  if (clock === undefined) {
    clock = { now: Date.now(), listeners: new Set(), timer: undefined };
    clocks.set(intervalMs, clock);
  }
  return clock;
}

function subscribeTo(intervalMs: number, listener: () => void): () => void {
  const clock = clockFor(intervalMs);
  if (clock.listeners.size === 0) {
    // The clock slept with nobody listening: catch up before the first tick.
    clock.now = Date.now();
    clock.timer = window.setInterval(() => {
      clock.now = Date.now();
      for (const l of clock.listeners) l();
    }, intervalMs);
  }
  clock.listeners.add(listener);
  return () => {
    clock.listeners.delete(listener);
    if (clock.listeners.size === 0) {
      window.clearInterval(clock.timer);
      clock.timer = undefined;
    }
  };
}

/** The current time in ms, refreshed every `intervalMs`, for relative labels like "5 min ago". */
export function useNow(intervalMs: number): number {
  // The same functions on every render: a new subscribe would leave and join the clock each time.
  const subscribe = useCallback((listener: () => void) => subscribeTo(intervalMs, listener), [intervalMs]);
  const snapshot = useCallback(() => clockFor(intervalMs).now, [intervalMs]);
  return useSyncExternalStore(subscribe, snapshot);
}
