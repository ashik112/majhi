import type { AccountStatus, AccountUsage, HealthCheck } from "@majhi/shared";

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
 */
export function statusFromHealthAndUsage(
  health: HealthCheck | undefined,
  usage: AccountUsage | undefined,
): AccountStatus {
  const status = statusFromHealth(health);
  if (status !== "healthy" || usage === undefined) return status;
  const worst = Math.max(usage.window?.usedPct ?? 0, usage.weekly?.usedPct ?? 0);
  if (worst >= FULL_USAGE_PCT) return "at-limit";
  if (worst >= HIGH_USAGE_PCT) return "running-high";
  return status;
}
