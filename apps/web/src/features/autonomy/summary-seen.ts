import type { AutonomySummary } from "@majhi/shared";
import { useSyncExternalStore } from "react";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { markSummarySeen, seenSummary, summaryIsFresh } from "./model";

const listeners = new Set<() => void>();

/** Records the summary as read and tells every screen that shows its dot. */
export function markSeen(day: string): void {
  markSummarySeen(day);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The newest summary when the owner has not opened it and it is from today or yesterday; otherwise
 * undefined. The sidebar's Captain dot and the Captain header chip both read this, so they agree.
 * Older summaries are not nagged about: the Summary link on the Captain page still opens the latest.
 */
export function useUnseenSummary(now: number): AutonomySummary | undefined {
  const summary = useAutonomyStatus().data?.summary;
  const seen = useSyncExternalStore(subscribe, seenSummary, () => undefined);
  if (summary === undefined || summary.day === seen || !summaryIsFresh(summary.day, now)) return undefined;
  return summary;
}
