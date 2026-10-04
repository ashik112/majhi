import {
  BAD_OUTCOMES,
  type FindingsTally,
  GOOD_OUTCOMES,
  OVERRULE_OUTCOMES,
  type Tally,
} from "@majhi/shared";
import type { OutcomeRow } from "./repo.ts";

/** The scorecard's arithmetic, pure: rows in, counts out. Zero actions give no percent, never a NaN. */

export const ZERO_TALLY: Tally = {
  actions: 0,
  judged: 0,
  kept: 0,
  overruled: 0,
  bad: 0,
  pending: 0,
  tokens: 0,
  costUsd: 0,
  minutesSaved: 0,
};

/** The minutes setting an output saves under: a draft is a draft, everything else its row. */
export function minutesKind(row: Pick<OutcomeRow, "kind" | "key">): string | undefined {
  if (row.kind === "draft") return "draft";
  if (row.kind === "finding") return undefined;
  return row.key;
}

function pct(part: number, whole: number): number | undefined {
  return whole === 0 ? undefined : Math.round((part / whole) * 1000) / 10;
}

/** What the captain did, from the outputs that are actions (findings have their own tally). */
export function tallyOf(
  rows: readonly OutcomeRow[],
  minutes: Readonly<Record<string, number>>,
  spend: { tokens: number; costUsd: number } = { tokens: 0, costUsd: 0 },
): Tally {
  let actions = 0;
  let judged = 0;
  let kept = 0;
  let bad = 0;
  let overruled = 0;
  let saved = 0;
  for (const r of rows) {
    if (r.kind === "finding" || r.result === "void") continue;
    actions++;
    if (r.result === undefined) continue;
    judged++;
    if (GOOD_OUTCOMES.includes(r.result)) {
      kept++;
      const k = minutesKind(r);
      if (k !== undefined) saved += minutes[k] ?? 0;
    } else if (BAD_OUTCOMES.includes(r.result)) {
      bad++;
      if (OVERRULE_OUTCOMES.includes(r.result)) overruled++;
    }
  }
  const keptPct = pct(kept, judged);
  const overruledPct = pct(overruled, judged);
  return {
    actions,
    judged,
    kept,
    overruled,
    bad,
    pending: actions - judged,
    ...(keptPct === undefined ? {} : { keptPct }),
    ...(overruledPct === undefined ? {} : { overruledPct }),
    tokens: Math.round(spend.tokens),
    costUsd: Math.round(spend.costUsd * 100) / 100,
    minutesSaved: Math.round(saved * 10) / 10,
  };
}

/** Findings a playbook or workspace filed, and how many the owner took against dismissed. */
export function findingsTally(rows: readonly OutcomeRow[]): FindingsTally {
  let filed = 0;
  let accepted = 0;
  let dismissed = 0;
  for (const r of rows) {
    if (r.kind !== "finding") continue;
    filed++;
    if (r.result === "accepted") accepted++;
    else if (r.result === "dismissed") dismissed++;
  }
  const conversionPct = pct(accepted, accepted + dismissed);
  return { filed, accepted, dismissed, ...(conversionPct === undefined ? {} : { conversionPct }) };
}
