/**
 * The numbering of `/api/events` frames, one counter per connection. Kept pure so the server's stamping
 * and the web's gap check are tested together.
 */

/** Hands out 1, 2, 3 ... for one connection. */
export class EventSeq {
  private last = 0;

  next(): number {
    this.last += 1;
    return this.last;
  }
}

/**
 * True when `next` does not follow `last`, so a frame was lost in between and the tab must read its
 * lists again. The first frame of a connection (`last` undefined) is never a gap. A frame without a
 * number cannot be checked and is not one.
 */
export function seqGap(last: number | undefined, next: number | undefined): boolean {
  if (last === undefined || next === undefined) return false;
  return next !== last + 1;
}
