import { GOOD_OUTCOMES, TRUST_DEMOTE_BELOW, TRUST_MUTE_ABOVE, TRUST_PROMOTE_ABOVE } from "@majhi/shared";
import type { OutcomeRow } from "./repo.ts";

/**
 * The trust ladder's rules, pure (SPEC 5.18). They read the last N judged outputs of one authority row
 * or channel, newest first. Integers only, so a boundary is exact: 16 of 20 is 80 percent and stays.
 */

export interface Window {
  judged: number;
  kept: number;
}

export function windowOf(rows: readonly OutcomeRow[]): Window {
  let kept = 0;
  for (const r of rows) if (r.result !== undefined && GOOD_OUTCOMES.includes(r.result)) kept++;
  return { judged: rows.length, kept };
}

/** Fewer than N judged outputs say nothing yet: the ladder never moves on thin evidence. */
export function shouldDemote(rows: readonly OutcomeRow[], n: number): boolean {
  if (rows.length < n) return false;
  const w = windowOf(rows.slice(0, n));
  return w.kept * 100 < TRUST_DEMOTE_BELOW * w.judged;
}

/**
 * More than 95 percent kept over the last N, and nothing taken back in the quiet days. `recent` is
 * whether the owner overruled or undid anything in them. Only ever a proposal.
 */
export function shouldPropose(rows: readonly OutcomeRow[], n: number, recent: boolean): boolean {
  if (rows.length < n || recent) return false;
  const w = windowOf(rows.slice(0, n));
  return w.kept * 100 > TRUST_PROMOTE_ABOVE * w.judged;
}

/** A playbook whose findings are dismissed more than 70 percent over the last N judged ones. */
export function shouldMute(findings: readonly OutcomeRow[], n: number): boolean {
  if (findings.length < n) return false;
  const last = findings.slice(0, n);
  const dismissed = last.filter((r) => r.result === "dismissed").length;
  return dismissed * 100 > TRUST_MUTE_ABOVE * last.length;
}

export function percent(w: Window): number {
  return w.judged === 0 ? 0 : Math.round((w.kept / w.judged) * 100);
}
