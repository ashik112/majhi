/** The longest gap between two runs coming back after a restart. */
export const RESUME_GAP_MS = 20_000;

export interface ResumeDripDeps {
  gapMs?: number;
  /** True when one more run may come back now: a free run under the cap and a machine that is not busy. */
  ready: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Brings the runs a restart cut back one by one: the first at once, then at most one every `gapMs`,
 * and only while `ready` says the cap and the machine allow it. Runs not yet started wait here, so a
 * restart never starts them all in the same minute.
 */
export class ResumeDrip {
  private stopped = false;

  constructor(private readonly deps: ResumeDripDeps) {}

  stop(): void {
    this.stopped = true;
  }

  async run<T>(items: readonly T[], start: (item: T) => void): Promise<void> {
    const gap = this.deps.gapMs ?? RESUME_GAP_MS;
    let first = true;
    for (const item of items) {
      if (!first) await this.deps.sleep(gap);
      first = false;
      while (!this.stopped && !(await this.deps.ready().catch(() => true))) await this.deps.sleep(gap);
      if (this.stopped) return;
      start(item);
    }
  }
}
