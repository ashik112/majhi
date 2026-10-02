/**
 * Work that starts after a request has answered (a title, a record of a closed task) and that
 * nobody awaits. Tracking it lets shutdown wait for it, so it never writes into a home or a
 * database that is already being removed.
 */
export class Background {
  private readonly pending = new Set<Promise<void>>();

  /** Runs `work` to its end and returns it unchanged; a failure stays the caller's to handle. */
  track<T>(work: Promise<T>): Promise<T> {
    const done = work.then(
      () => undefined,
      () => undefined,
    );
    this.pending.add(done);
    void done.then(() => this.pending.delete(done));
    return work;
  }

  /** Resolves once nothing is running, including work that started while it waited. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
