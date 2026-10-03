/**
 * Work the services start without waiting for it: run hooks, sweeps, startup chores. Shutdown
 * stops new work and waits for what runs, so nothing writes into the home after the stores close.
 */
export class Background {
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  /** Starts `work` unless shutdown began. Its errors go to `onError`, or are dropped. */
  run(work: () => Promise<unknown>, onError?: (err: unknown) => void): void {
    if (this.stopped) return;
    // Started at once, as a direct call would: hooks keep their order with the code after them.
    let started: Promise<unknown>;
    try {
      started = work();
    } catch (err) {
      started = Promise.reject(err);
    }
    const done = started
      .then(
        () => undefined,
        (err: unknown) => onError?.(err),
      )
      .finally(() => this.running.delete(done));
    this.running.add(done);
  }

  /** Refuses new work at once, and resolves when the work already started has ended. */
  async stop(): Promise<void> {
    this.stopped = true;
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }
}
