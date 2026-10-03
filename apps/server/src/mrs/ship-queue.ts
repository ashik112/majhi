/**
 * Ships into one base branch go one at a time, in the order they were asked (SPEC 5.18, workspaces
 * never collide). A ship holds one place per `project` and target branch it merges into; a later
 * ship into the same pair waits for the earlier one to finish, then goes. Ships into different
 * pairs do not wait for each other.
 */
export class ShipQueue {
  /** The end of the line per `project` and target. */
  private readonly tails = new Map<string, Promise<void>>();

  static key(project: string, into: string): string {
    return `${project}\u0000${into}`;
  }

  /** Runs `work` once every earlier ship into any of `keys` is over. */
  async run<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort();
    let release: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Take the place in every line now, in one step, so the order of asking is the order of going.
    const behind = unique.map((k) => this.tails.get(k) ?? Promise.resolve());
    for (const k of unique) this.tails.set(k, done);
    try {
      await Promise.all(behind);
      return await work();
    } finally {
      release();
      for (const k of unique) if (this.tails.get(k) === done) this.tails.delete(k);
    }
  }

  /** True while a ship into this pair runs or waits. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}
