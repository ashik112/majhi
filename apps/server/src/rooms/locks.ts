/**
 * One lock per worktree (SPEC 5.3): two agents never edit the same worktree at the same time.
 * An agent that edits takes the locks of its worktrees for a whole turn. Locks are taken in path
 * order, so two agents that need the same two worktrees cannot wait on each other forever.
 * Waiters are served first come, first served. Held in memory: a restart ends every turn anyway.
 */
export class WorktreeLocks {
  private readonly holders = new Map<string, string>();
  private readonly waiters = new Map<string, { owner: string; grant: () => void }[]>();

  /** Who holds the worktree now, if anyone. */
  holder(path: string): string | undefined {
    return this.holders.get(path);
  }

  /**
   * Takes every path for `owner`. `onWait` hears which path and holder it waits for. Resolves
   * with a release function, or rejects when `signal` aborts (the locks taken so far are released).
   */
  async acquire(
    paths: readonly string[],
    owner: string,
    options: { signal?: AbortSignal; onWait?: (path: string, holder: string) => void } = {},
  ): Promise<() => void> {
    const taken: string[] = [];
    const release = () => {
      for (const p of taken.splice(0)) this.release(p, owner);
    };
    try {
      for (const path of [...new Set(paths)].sort()) {
        await this.take(path, owner, options);
        taken.push(path);
      }
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }

  private take(
    path: string,
    owner: string,
    options: { signal?: AbortSignal; onWait?: (path: string, holder: string) => void },
  ): Promise<void> {
    const holder = this.holders.get(path);
    if (holder === undefined || holder === owner) {
      this.holders.set(path, owner);
      return Promise.resolve();
    }
    options.onWait?.(path, holder);
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      const entry = {
        owner,
        grant: () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        const list = this.waiters.get(path) ?? [];
        this.waiters.set(
          path,
          list.filter((w) => w !== entry),
        );
        reject(new Error("Stopped while waiting for a worktree"));
      };
      if (signal?.aborted) {
        reject(new Error("Stopped while waiting for a worktree"));
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      const list = this.waiters.get(path) ?? [];
      list.push(entry);
      this.waiters.set(path, list);
    });
  }

  private release(path: string, owner: string): void {
    if (this.holders.get(path) !== owner) return;
    const list = this.waiters.get(path) ?? [];
    const next = list.shift();
    if (list.length === 0) this.waiters.delete(path);
    if (next === undefined) {
      this.holders.delete(path);
      return;
    }
    this.holders.set(path, next.owner);
    next.grant();
  }
}
