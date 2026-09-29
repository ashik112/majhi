import type { CommandOutput } from "@majhi/shared";
import type { DotTone } from "@/components/ui/status-dot";

export type CheckRow = CommandOutput<"health.run">["checks"][number];
export type CheckGroupId = CheckRow["group"];

const GROUPS: readonly { id: CheckGroupId; title: string }[] = [
  { id: "majhi", title: "majhi" },
  { id: "host", title: "This Mac" },
  { id: "ssh", title: "Git over SSH" },
  { id: "accounts", title: "Accounts" },
  { id: "disk", title: "Disk" },
];

export interface CheckGroup {
  id: CheckGroupId;
  title: string;
  rows: CheckRow[];
}

/** Rows in the demo's order: failed first inside a group, then warnings, then passes. Empty groups are dropped. */
export function groupChecks(checks: readonly CheckRow[]): CheckGroup[] {
  const rank = { fail: 0, warn: 1, pass: 2 } as const;
  return GROUPS.map(({ id, title }) => ({
    id,
    title,
    rows: checks
      .filter((c) => c.group === id)
      .map((c, index) => ({ c, index }))
      .sort((a, b) => rank[levelOf(a.c)] - rank[levelOf(b.c)] || a.index - b.index)
      .map(({ c }) => c),
  })).filter((g) => g.rows.length > 0);
}

export function levelOf(check: Pick<CheckRow, "ok" | "level">): "pass" | "warn" | "fail" {
  return check.level ?? (check.ok ? "pass" : "fail");
}

export function checkTone(check: Pick<CheckRow, "ok" | "level">): DotTone {
  const level = levelOf(check);
  return level === "pass" ? "green" : level === "warn" ? "amber" : "red";
}

/**
 * Failed checks the owner has to look at, for the sidebar. Accounts are left out: their failures
 * are already counted from the accounts themselves, and a warning is not a failure.
 */
export function checksNeedingYou(checks: readonly CheckRow[] | undefined): number {
  return (checks ?? []).filter((c) => c.group !== "accounts" && levelOf(c) === "fail").length;
}

/** "3 need you" text for the Health and usage badge, from accounts and failed checks together. */
export function needYouText(count: number): string | undefined {
  return count > 0 ? `${count} need you` : undefined;
}

/** The line above the checks, like "2 failed, 1 warning" or "All checks passed". */
export function checksSummary(checks: readonly CheckRow[]): string {
  const failed = checks.filter((c) => levelOf(c) === "fail").length;
  const warned = checks.filter((c) => levelOf(c) === "warn").length;
  if (failed + warned === 0) return "All checks passed";
  const parts = [];
  if (failed > 0) parts.push(`${failed} failed`);
  if (warned > 0) parts.push(`${warned} ${warned === 1 ? "warning" : "warnings"}`);
  return parts.join(", ");
}
