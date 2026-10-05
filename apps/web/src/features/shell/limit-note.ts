import type { AccountView } from "@majhi/shared";
import { accountAtLimit } from "./model";

/** "14:00" today, or "Tue 14:00" when the reset is more than a day away. */
export function resetClock(iso: string, now: number): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (at.getTime() - now < 20 * 3_600_000) return time;
  return `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export interface LimitNote {
  text: string;
  /** At the limit now (paused lamp) rather than only close to it. */
  full: boolean;
}

/**
 * What to say about an account's usage window: at its limit with the reset time, or close to it.
 * A run's limit error (`account.limit`) knows the reset better than the last usage read; "about"
 * when majhi guessed it.
 */
export function limitNote(account: AccountView | undefined, now: number): LimitNote | undefined {
  if (!account) return undefined;
  const windows = [account.usage?.window, account.usage?.weekly].filter((w) => w !== undefined);
  const worst = windows.toSorted((a, b) => b.usedPct - a.usedPct)[0];
  if (accountAtLimit(account)) {
    const resets = account.limit?.until ?? worst?.resetsAt;
    const about = account.limit !== undefined && !account.limit.resetKnown ? "about " : "";
    return {
      text: resets ? `At limit, back ${about}${resetClock(resets, now)}` : "At limit",
      full: true,
    };
  }
  if (worst && worst.usedPct >= 80) {
    const label = worst === account.usage?.weekly ? "weekly" : "5h";
    return { text: `${Math.round(worst.usedPct)}% of ${label} window`, full: false };
  }
  return undefined;
}
