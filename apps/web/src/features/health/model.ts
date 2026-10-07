import type { CommandOutput } from "@majhi/shared";
import type { DotTone } from "@/components/ui/status-dot";

export type CheckRow = CommandOutput<"health.run">["checks"][number];
export type CheckGroupId = CheckRow["group"];

const GROUPS: readonly { id: CheckGroupId; title: string }[] = [
  { id: "majhi", title: "majhi" },
  { id: "host", title: "This computer" },
  { id: "ssh", title: "Git over SSH" },
  { id: "accounts", title: "Accounts" },
  { id: "connections", title: "Connections" },
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

/** "3 to fix" text for the Health and usage badge, from accounts and failed checks together. */
export function needYouText(count: number): string | undefined {
  return count > 0 ? `${count} to fix` : undefined;
}

/** The page's status line: "All 22 checks passed", "1 check to fix" or "2 checks to fix". */
export function checksHeadline(checks: readonly CheckRow[]): string {
  const open = checks.filter((c) => levelOf(c) !== "pass").length;
  if (open === 0) return `All ${checks.length} checks passed`;
  return open === 1 ? "1 check to fix" : `${open} checks to fix`;
}

/** The checks that need the owner: failures only. A warning is a note, and does not count. */
export function failedChecks(checks: readonly CheckRow[]): number {
  return checks.filter((c) => levelOf(c) === "fail").length;
}

/** The checks that are not passing, failures first: always shown open, with their fixes. */
export function openChecks(checks: readonly CheckRow[]): CheckRow[] {
  const rank = { fail: 0, warn: 1, pass: 2 } as const;
  return checks.filter((c) => levelOf(c) !== "pass").toSorted((a, b) => rank[levelOf(a)] - rank[levelOf(b)]);
}

/** Checks that pass, in the order the server listed them. */
export function passingChecks(checks: readonly CheckRow[]): CheckRow[] {
  return checks.filter((c) => levelOf(c) === "pass");
}

/** "Checked 31: 28 ok, 3 need you". */
export function runSummary(checks: readonly CheckRow[]): string {
  const need = failedChecks(checks);
  const notes = checks.filter((c) => levelOf(c) === "warn").length;
  return `Checked ${checks.length}: ${checks.length - need - notes} ok, ${need} need you${notes > 0 ? `, ${notes} to know` : ""}`;
}

/**
 * The one button of a row that is not passing. A connection's fix opens its page (Reconnect or Open
 * settings); any other fix runs `health.fix`. A row without a fix has no such button.
 */
export function rowFix(row: CheckRow): { label: string; kind: "fix" | "open-connection" } | undefined {
  if (row.fix === undefined) return undefined;
  return { label: row.fix.label, kind: row.id.startsWith("connection:") ? "open-connection" : "fix" };
}
