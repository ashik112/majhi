import {
  type AccountStatus,
  type AccountUsage,
  type HealthCheck,
  type HealthStep,
  type OrgView,
  PERSONAL,
} from "@majhi/shared";

/** Ids an org may not use: they mean something else in agent files and accounts. */
const RESERVED_ORG_IDS: readonly string[] = [PERSONAL, "root"];

/** Turns an org name into an id: "Acme Corp." becomes "acme-corp". Empty when the name has no letters or digits. */
export function orgIdFromName(name: string): string {
  const id = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return RESERVED_ORG_IDS.includes(id) ? `${id}-org` : id;
}

/** Colors offered for a new org. Same hues as the design tokens. */
export const ORG_COLORS = ["#8ab8f5", "#7fd1b9", "#f59c7f", "#c3a6f5", "#f0b455"] as const;

/** The next color in the palette for the nth org, so new orgs start out different. */
export function suggestOrgColor(orgCount: number): string {
  return ORG_COLORS[orgCount % ORG_COLORS.length] ?? ORG_COLORS[0];
}

export type Tone = "green" | "amber" | "red" | "neutral";

export interface StatusInfo {
  label: string;
  tone: Tone;
}

const STATUS: Record<AccountStatus, StatusInfo> = {
  unknown: { label: "Not checked", tone: "neutral" },
  healthy: { label: "Healthy", tone: "green" },
  "needs-login": { label: "Needs login", tone: "red" },
  "running-high": { label: "Running high", tone: "amber" },
  "at-limit": { label: "At limit", tone: "red" },
  "relogin-soon": { label: "Sign in soon", tone: "amber" },
  unreachable: { label: "Unreachable", tone: "red" },
};

export function statusInfo(status: AccountStatus): StatusInfo {
  return STATUS[status];
}

/** True when the account can run agents now: signed in and answering. */
export function isUsableStatus(status: AccountStatus): boolean {
  return status === "healthy" || status === "running-high" || status === "relogin-soon";
}

export interface OrgLabel {
  name: string;
  color?: string;
}

/** Display name and color for an account's org id. Unknown ids show as they are. */
export function orgLabel(orgId: string, orgs: readonly OrgView[]): OrgLabel {
  if (orgId === PERSONAL) return { name: "Personal" };
  const org = orgs.find((o) => o.id === orgId);
  if (!org) return { name: orgId };
  return org.color ? { name: org.name, color: org.color } : { name: org.name };
}

/** "in 2 h", "in 35 min", "now". */
export function formatIn(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const minutes = Math.round((then - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** Usage lines for the table. Empty when there is nothing to show. */
export function usageLines(usage: AccountUsage | undefined, now: number): string[] {
  if (!usage) return [];
  const mark = usage.estimated ? " (estimated)" : "";
  const lines: string[] = [];
  if (usage.window) {
    const reset = usage.window.resetsAt ? `, resets ${formatIn(usage.window.resetsAt, now)}` : "";
    lines.push(`${Math.round(usage.window.usedPct)}% of current window${reset}${mark}`);
  }
  if (usage.weekly) lines.push(`${Math.round(usage.weekly.usedPct)}% this week${mark}`);
  return lines;
}

/** The first step that failed, or undefined when all passed. */
export function failingStep(health: HealthCheck): HealthStep | undefined {
  return health.steps.find((s) => !s.ok);
}

const STEP_LABEL: Record<HealthStep["name"], string> = {
  cli: "Tool starts",
  auth: "Signed in",
  acp: "Agent session opens",
  model: "Model offered",
};

export function stepLabel(name: HealthStep["name"]): string {
  return STEP_LABEL[name];
}
