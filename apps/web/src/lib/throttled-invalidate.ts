import type { QueryClient } from "@tanstack/react-query";

/** A key is refetched at most this often. A burst of events becomes one refetch now and one at the end. */
const WINDOW_MS = 300;

/**
 * Refetches the queries under a key when the server says they changed, but not more than once per
 * `WINDOW_MS` per key: the first change refetches at once, the rest of a burst share one more refetch
 * when the window closes. Without it a burst of events (a start-up, a long turn) refetched the same
 * lists a dozen times, and each refetch cost the single-threaded server a turn.
 */
export function throttledInvalidator(client: QueryClient): {
  invalidate: (queryKey: readonly string[]) => void;
  stop: () => void;
} {
  const lastRun = new Map<string, number>();
  const trailing = new Map<string, number>();

  const run = (id: string, queryKey: readonly string[]) => {
    lastRun.set(id, performance.now());
    void client.invalidateQueries({ queryKey });
  };

  return {
    invalidate(queryKey) {
      const id = queryKey.join("/");
      if (trailing.has(id)) return;
      const wait = (lastRun.get(id) ?? Number.NEGATIVE_INFINITY) + WINDOW_MS - performance.now();
      if (wait <= 0) {
        run(id, queryKey);
        return;
      }
      trailing.set(
        id,
        window.setTimeout(() => {
          trailing.delete(id);
          run(id, queryKey);
        }, wait),
      );
    },
    stop() {
      for (const timer of trailing.values()) window.clearTimeout(timer);
      trailing.clear();
    },
  };
}
