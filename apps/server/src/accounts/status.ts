import type { AccountLimit, AccountStatus, AccountUsage, HealthCheck } from "@majhi/shared";

/** Usage at or above this share of a window makes the account `running-high`. */
export const HIGH_USAGE_PCT = 80;
export const FULL_USAGE_PCT = 100;

/**
 * `unknown` before any check, `healthy` when it passed, `needs-login` when the
 * sign-in step failed, `unreachable` when the CLI or the ACP session failed.
 */
export function statusFromHealth(health: HealthCheck | undefined): AccountStatus {
  if (health === undefined) return "unknown";
  if (health.ok) return "healthy";
  const failed = (name: string) => health.steps.some((s) => s.name === name && !s.ok);
  if (failed("cli")) return "unreachable";
  if (failed("auth")) return "needs-login";
  return "unreachable";
}

/**
 * Health decides, except that a healthy account whose 5-hour or weekly window is
 * full is `at-limit`, and one at 80 % or more is `running-high`. Per-model windows
 * do not count: a full Opus window does not stop the account using Sonnet. A failed
 * usage read never changes the status: the numbers in `usage` are then the last good ones.
 * An account a run's limit error holds (`limit`) is `at-limit` until its `until` passes, whatever
 * the last usage read said.
 */
export function statusFromHealthAndUsage(
  health: HealthCheck | undefined,
  usage: AccountUsage | undefined,
  limit?: AccountLimit,
  now: Date = new Date(),
): AccountStatus {
  const status = statusFromHealth(health);
  if (status === "needs-login" || status === "unreachable") return status;
  if (limitActive(limit, now)) return "at-limit";
  if (status !== "healthy" || usage === undefined) return status;
  const worst = Math.max(usage.window?.usedPct ?? 0, usage.weekly?.usedPct ?? 0);
  if (worst >= FULL_USAGE_PCT) return "at-limit";
  if (worst >= HIGH_USAGE_PCT) return "running-high";
  return status;
}

/** How long an account counts as at its limit when the error and the usage windows say no reset. */
export const LIMIT_GUESS_MS = 15 * 60_000;

/** Whether a limit mark still holds at `now`. */
export function limitActive(limit: AccountLimit | undefined, now: Date): limit is AccountLimit {
  return limit !== undefined && now.getTime() < Date.parse(limit.until);
}

/**
 * The latest reset among the usage windows that are full and reset in the future, or undefined.
 * When both the 5-hour and the weekly window are full, the account works again when both reset.
 */
export function fullWindowReset(usage: AccountUsage | undefined, now: Date): Date | undefined {
  let latest: number | undefined;
  for (const w of [usage?.window, usage?.weekly]) {
    if (w === undefined || w.usedPct < FULL_USAGE_PCT || w.resetsAt === undefined) continue;
    const at = Date.parse(w.resetsAt);
    if (Number.isNaN(at) || at <= now.getTime()) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest === undefined ? undefined : new Date(latest);
}

/**
 * The limit mark for a run's limit error: the error's reset, else the full usage window's reset,
 * else a short guess. `before` is a mark that still holds: an error with no reset keeps its end, so
 * a second agent on the account does not shorten it.
 */
export function limitFor(
  failure: { detail: string; resetsAt?: string | undefined },
  usage: AccountUsage | undefined,
  now: Date,
  before?: AccountLimit,
): AccountLimit {
  const since = limitActive(before, now) ? before.since : now.toISOString();
  if (failure.resetsAt !== undefined) {
    return { since, until: failure.resetsAt, resetKnown: true, detail: failure.detail };
  }
  if (limitActive(before, now)) return { ...before, detail: failure.detail };
  const window = fullWindowReset(usage, now);
  const until = window ?? new Date(now.getTime() + LIMIT_GUESS_MS);
  return { since, until: until.toISOString(), resetKnown: false, detail: failure.detail };
}
