/**
 * What to do with each agent run when the computer wakes from sleep (SPEC 5.7). The container sleeps
 * with the computer, so turns come back either cut (the agent failed on a dropped connection) or
 * stalled (still open, but nothing arrives). Pure, so the rules are tested alone.
 */

export interface WakeView {
  key: string;
  /** A turn is open. */
  turning: boolean;
  /** The turn was cut and waits to continue (offline, crash). */
  interrupted: boolean;
  /** The last turn failed with an error that may pass (network, timeout). */
  retryable: boolean;
  /** Last time the agent reported anything, in ms. */
  lastEventAt: number;
}

/** A turn with no event for this long after a wake counts as stalled. */
export const STALL_MS = 60_000;

export interface WakePlan {
  /** Continue these: send "Continue from where you stopped". */
  resume: string[];
  /** Stop these open turns first, then continue them. */
  restart: string[];
}

/**
 * `now` is when the server hears of the wake. The server's clock jumped with the computer's, so an open
 * turn whose last event is older than the stall window has not heard from its agent since the sleep.
 */
export function wakePlan(runs: readonly WakeView[], now: number, stallMs: number = STALL_MS): WakePlan {
  const plan: WakePlan = { resume: [], restart: [] };
  for (const r of runs) {
    if (r.turning) {
      if (now - r.lastEventAt >= stallMs) plan.restart.push(r.key);
      continue;
    }
    if (r.interrupted || r.retryable) plan.resume.push(r.key);
  }
  return plan;
}
