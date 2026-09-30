/** Watches the tasks whose MRs are open: reads their state, merges under `auto-if-green`, and notices merges the owner did. */
export const POLL_INTERVAL_MS = 60_000;

export class MrPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly poll: () => Promise<void>,
    private readonly intervalMs = POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. A pass that is still running makes the next one a no-op. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.poll();
    } catch (err) {
      console.error(`MR poll failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
