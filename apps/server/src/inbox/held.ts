interface Waiting {
  timer: NodeJS.Timeout;
  run: () => Promise<unknown>;
  failed: (error: unknown) => void;
}

/**
 * Answers the owner gave that wait out their Undo time on the server, so closing the tab does not lose
 * one. One entry per key (a decision id, or `ask:<task>:<item>`): sending again while one waits changes
 * nothing, Undo drops it, and when the time is up it runs once. At shutdown the waiting ones are sent
 * at once rather than lost.
 */
export class HeldAnswers {
  private readonly waiting = new Map<string, Waiting>();

  /** True when this call started the wait, false when one for the key was already waiting. */
  hold(key: string, ms: number, run: () => Promise<unknown>, failed: (error: unknown) => void): boolean {
    if (this.waiting.has(key)) return false;
    const timer = setTimeout(() => void this.fire(key), ms);
    this.waiting.set(key, { timer, run, failed });
    return true;
  }

  /** True when an answer was waiting and is now dropped. */
  cancel(key: string): boolean {
    const held = this.waiting.get(key);
    if (held === undefined) return false;
    clearTimeout(held.timer);
    this.waiting.delete(key);
    return true;
  }

  has(key: string): boolean {
    return this.waiting.has(key);
  }

  /** Sends everything that waits now, for a shutdown. */
  async flush(): Promise<void> {
    await Promise.all([...this.waiting.keys()].map((key) => this.fire(key)));
  }

  private async fire(key: string): Promise<void> {
    const held = this.waiting.get(key);
    if (held === undefined) return;
    clearTimeout(held.timer);
    this.waiting.delete(key);
    try {
      await held.run();
    } catch (error) {
      held.failed(error);
    }
  }
}
