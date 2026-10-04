/** A load that hovers at the busy line flips often; one calm wake per this long is enough. */
const CALM_WAKE_GAP_MS = 10 * 60_000;

/** Decides when a busy machine turning calm is news: once per flip, and not again within the gap. */
export class CalmWake {
  private wasBusy = false;
  private last = Number.NEGATIVE_INFINITY;

  /** True when this reading is the busy to calm flip that should wake the captain. */
  read(busy: boolean, atMs: number): boolean {
    const flipped = this.wasBusy && !busy;
    this.wasBusy = busy;
    if (!flipped || atMs - this.last < CALM_WAKE_GAP_MS) return false;
    this.last = atMs;
    return true;
  }
}
