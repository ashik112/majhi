import type { CaptainAction, CaptainRun } from "@majhi/shared";

export interface CaptainLog {
  actions: CaptainAction[];
  runs: CaptainRun[];
}

/** How many lines of the log a tab holds. */
export const LOG_LIMIT = 100;
const RUN_LIMIT = 50;

/**
 * Puts a catch-up read (lines newer than the newest the tab holds, and the newest few runs) into the
 * held log. New lines go first; a run that came back replaces its old row. Lines already held keep
 * their objects. `null` means the read filled its page, so lines between the two may be missing: the
 * caller reads the whole log again.
 */
export function mergeLog(held: CaptainLog, news: CaptainLog, limit = LOG_LIMIT): CaptainLog | null {
  if (news.actions.length >= limit) return null;
  const seen = new Set(held.actions.map((a) => a.id));
  const fresh = news.actions.filter((a) => !seen.has(a.id));
  const actions = fresh.length === 0 ? held.actions : [...fresh, ...held.actions].slice(0, limit);
  const heldRuns = new Map(held.runs.map((r) => [r.id, r]));
  const changed = news.runs.some((r) => JSON.stringify(heldRuns.get(r.id)) !== JSON.stringify(r));
  if (!changed) return actions === held.actions ? held : { actions, runs: held.runs };
  const byId = new Map(held.runs.map((r) => [r.id, r]));
  for (const r of news.runs) byId.set(r.id, r);
  const runs = [...byId.values()].toSorted((a, b) => b.id - a.id).slice(0, RUN_LIMIT);
  return { actions, runs };
}

/** The held log with one line replaced (an undone action). */
export function replaceAction(held: CaptainLog, action: CaptainAction): CaptainLog {
  return { ...held, actions: held.actions.map((a) => (a.id === action.id ? action : a)) };
}
