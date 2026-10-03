import {
  FINDING_LIVE,
  FINDING_SOURCE_LABEL,
  type Finding,
  type FindingSeverity,
  type FindingSource,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

/** The groups of the Findings sheet. `tasks` is every finding that became a task or a proposal. */
export type FindingGroup = "open" | "tasks" | "dismissed" | "fixed" | "all";

export const GROUPS: readonly { value: FindingGroup; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "tasks", label: "Tasks" },
  { value: "dismissed", label: "Dismissed" },
  { value: "fixed", label: "Fixed" },
  { value: "all", label: "All" },
];

export function inGroup(f: Finding, group: FindingGroup): boolean {
  switch (group) {
    case "open":
      return f.status === "open" || f.status === "decision";
    case "tasks":
      return f.status === "proposed" || f.status === "task";
    case "dismissed":
      return f.status === "dismissed";
    case "fixed":
      return f.status === "fixed";
    default:
      return true;
  }
}

export const SEVERITY_RANK: Record<FindingSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };

export const SEVERITY_LAMP: Record<FindingSeverity, LampState> = {
  high: "needs",
  medium: "paused",
  low: "idle",
  info: "idle",
};

export const SEVERITY_WORD: Record<FindingSeverity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** The open findings that matter most: severity first, then the most recently seen. */
export function topFindings(all: readonly Finding[], count: number): Finding[] {
  return all
    .filter((f) => f.status === "open")
    .sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.lastSeen < b.lastSeen ? 1 : -1),
    )
    .slice(0, count);
}

/** Findings with a task still going, newest first, for the "became tasks" lines. */
export function taskFindings(all: readonly Finding[]): Finding[] {
  return all.filter((f) => (f.status === "proposed" || f.status === "task") && f.task !== undefined);
}

export function sourceLabel(source: FindingSource): string {
  return FINDING_SOURCE_LABEL[source];
}

/** Whether a finding still asks for attention. */
export function isLive(f: Finding): boolean {
  return FINDING_LIVE.includes(f.status);
}

/** The sources that appear in the findings, in the registry's order, for the filter. */
export function sourcesIn(all: readonly Finding[]): FindingSource[] {
  const seen = new Set(all.map((f) => f.source));
  return (Object.keys(FINDING_SOURCE_LABEL) as FindingSource[]).filter((s) => seen.has(s));
}
