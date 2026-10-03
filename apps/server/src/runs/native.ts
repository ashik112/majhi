import type { SessionEvent } from "@majhi/acp";

/**
 * Compactions the agent's CLI does on its own inside a turn (PRV-103), once the context reaches the
 * window majhi gave it at launch (SPEC 5.13). majhi did not ask for them, so it only watches: the
 * adapter's compaction report, else a sharp fall in context use between two readings of one session.
 */

/** A reading this far under the one before it is a compaction... */
export const DROP_SHARE = 0.6;
/** ...when it also freed at least this many tokens, so small swings do not count. */
export const DROP_MIN_TOKENS = 20_000;

/** One compaction to record: tokens in the context before and after, when known. */
export interface NativeCompaction {
  before: number | undefined;
  after: number | undefined;
}

/** True when context use fell from `before` to `after` the way only a compaction makes it fall. */
export function sharpDrop(before: number, after: number): boolean {
  return after < before * DROP_SHARE && before - after >= DROP_MIN_TOKENS;
}

interface Open {
  id: string;
  before: number | undefined;
  after: number | undefined;
  done: boolean;
  /** False for one the owner or majhi asked for (`/compact`). */
  record: boolean;
}

/**
 * Turns one session's compaction reports and usage readings into compactions to record, each once.
 * A report waits until it ended and the size after is known: from the adapter (Claude) or the next
 * reading (Codex). The reading that follows a reported compaction is not taken for a second one.
 */
export class NativeWatch {
  private open: Open | undefined;
  private recorded: string | undefined;
  private skipDrop = false;

  /** The adapter reported a compaction; `used` is the last reading before it. */
  report(
    e: Extract<SessionEvent, { type: "compaction" }>,
    used: number | undefined,
  ): NativeCompaction | undefined {
    if (e.id === this.recorded) return undefined;
    if (this.open?.id !== e.id) {
      this.open = { id: e.id, before: used, after: undefined, done: false, record: true };
    }
    const open = this.open;
    if (e.before !== undefined) open.before = e.before;
    if (e.after !== undefined) open.after = e.after;
    if (e.trigger === "manual") open.record = false;
    if (e.status === "failed") {
      this.open = undefined;
      return undefined;
    }
    if (e.status === "completed") open.done = true;
    if (!open.done || open.after === undefined) return undefined;
    this.skipDrop = true;
    return this.close(open);
  }

  /** A usage reading; `previous` is the reading before it in this session. */
  usage(previous: number | undefined, used: number): NativeCompaction | undefined {
    const open = this.open;
    if (open !== undefined) {
      if (!open.done) return undefined;
      // Older adapters report 0 until the next model call: no size, rather than a wrong one.
      open.after = used > 0 ? used : undefined;
      return this.close(open);
    }
    if (this.skipDrop) {
      this.skipDrop = false;
      return undefined;
    }
    if (previous === undefined || !sharpDrop(previous, used)) return undefined;
    return { before: previous, after: used };
  }

  /** majhi compacted or handed off itself: what the session reported meanwhile is accounted for. */
  reset(): void {
    this.open = undefined;
    this.skipDrop = false;
  }

  private close(open: Open): NativeCompaction | undefined {
    this.open = undefined;
    this.recorded = open.id;
    return open.record ? { before: open.before, after: open.after } : undefined;
  }
}
