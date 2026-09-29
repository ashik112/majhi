import type { AccountStatus, HealthCheck } from "@majhi/shared";

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
