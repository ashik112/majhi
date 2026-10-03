import {
  type AccountLimit,
  type AccountStatus,
  type AccountUsage,
  type AccountView,
  currentOrgId,
  type HealthCheck,
  type HealthStep,
  LEGACY_PERSONAL,
  type OrgView,
  PRIVATE,
  PRIVATE_NAME,
} from "@majhi/shared";

/** Ids an org may not use: they mean something else in agent files and accounts. */
const RESERVED_ORG_IDS: readonly string[] = [PRIVATE, LEGACY_PERSONAL, "root"];

/**
 * The org a form starts on: the org filter when it names one, else the only org besides Private,
 * else Private.
 */
export function defaultOrgId(orgs: readonly Pick<OrgView, "id">[], filter?: string): string {
  if (filter !== undefined && orgs.some((o) => o.id === filter)) return filter;
  const others = orgs.filter((o) => o.id !== PRIVATE);
  const [only] = others;
  return others.length === 1 && only ? only.id : PRIVATE;
}

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

/** The name of an org color, for its swatch's label. A color set by hand is the "Custom" one. */
export function orgColorName(color: string): string {
  const names: Record<string, string> = {
    "#8ab8f5": "Blue",
    "#7fd1b9": "Green",
    "#f59c7f": "Coral",
    "#c3a6f5": "Violet",
    "#f0b455": "Amber",
  };
  return names[color.toLowerCase()] ?? "Custom";
}

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
  const org = orgs.find((o) => o.id === currentOrgId(orgId));
  if (!org) return { name: currentOrgId(orgId) === PRIVATE ? PRIVATE_NAME : orgId };
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

/** Share of a window at which the bar turns amber, and at which it turns red. */
export const USAGE_HIGH_PCT = 80;
export const USAGE_FULL_PCT = 100;

/** "42%". Whole numbers; the tools report whole percentages anyway. */
export function formatPct(pct: number): string {
  return `${Math.round(pct)}%`;
}

/** Amber from 80 %, red at 100 %, calm below. */
export function usageTone(pct: number): Tone {
  if (pct >= USAGE_FULL_PCT) return "red";
  if (pct >= USAGE_HIGH_PCT) return "amber";
  return "neutral";
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const DAY_MS = 86_400_000;

/**
 * Reset time in local time for the table: the time only when it is today ("9:30 PM"),
 * a short weekday within the next six days ("Thu"), otherwise a short date ("Oct 6").
 */
export function resetLabel(iso: string, now: number, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown time";
  if (sameDay(at, new Date(now))) {
    return at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  }
  if (at.getTime() - now < 6 * DAY_MS) return at.toLocaleDateString(locale, { weekday: "short" });
  return at.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** Full reset for the details panel: "Thu, Oct 3, 12:00 AM". */
export function resetFull(iso: string, locale?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "unknown time";
  return at.toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface UsageRow {
  /** "5h", "Week", or a model name. */
  label: string;
  pct: number;
  tone: Tone;
  /** Reset for the table, like "9:30 PM" or "Thu". Absent when the tool gave none. */
  reset?: string;
}

/** The 5-hour and weekly rows for the table. Empty when the account reported neither. */
export function usageRows(usage: AccountUsage | undefined, now: number, locale?: string): UsageRow[] {
  if (!usage) return [];
  const row = (label: string, w: { usedPct: number; resetsAt?: string | undefined }): UsageRow => ({
    label,
    pct: w.usedPct,
    tone: usageTone(w.usedPct),
    ...(w.resetsAt ? { reset: resetLabel(w.resetsAt, now, locale) } : {}),
  });
  const rows: UsageRow[] = [];
  if (usage.window) rows.push(row("5h", usage.window));
  if (usage.weekly) rows.push(row("Week", usage.weekly));
  return rows;
}

/** "5h 42% · 9:30 PM", or "Week 18%" when there is no reset time. */
export function usageRowText(row: UsageRow): string {
  const base = `${row.label} ${formatPct(row.pct)}`;
  return row.reset ? `${base} · ${row.reset}` : base;
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

/** Bar color: green while there is room, amber from 80 %, red at 100 %. */
export function barTone(pct: number): "green" | "amber" | "red" {
  const tone = usageTone(pct);
  return tone === "neutral" ? "green" : tone === "amber" ? "amber" : "red";
}

/** When an account at its limit comes back: the run's limit error says, else the window that is full. */
export function limitResetAt(account: Pick<AccountView, "limit" | "usage">): string | undefined {
  return account.limit?.until ?? account.usage?.window?.resetsAt ?? account.usage?.weekly?.resetsAt;
}

/** "At limit until 3:40 PM", or "until about" when majhi guessed the reset. */
export function limitUntilText(
  limit: Pick<AccountLimit, "until" | "resetKnown">,
  now: number,
  locale?: string,
) {
  const about = limit.resetKnown ? "" : "about ";
  return `At limit until ${about}${resetLabel(limit.until, now, locale)}`;
}

/** The status column: the status label, and for an account at its limit when it resets, like `Limit reached · 3:40 PM`. */
export function statusText(
  account: Pick<AccountView, "status" | "usage" | "limit">,
  now: number,
  locale?: string,
): StatusInfo {
  if (account.status !== "at-limit") return statusInfo(account.status);
  const resets = limitResetAt(account);
  const label = resets ? `Limit reached · ${resetLabel(resets, now, locale)}` : "Limit reached";
  return { label, tone: "red" };
}

/** The account whose window is fullest, for the board's top bar. */
export interface BusiestAccount {
  id: string;
  /** The fullest window's share, 100 while a run's limit error holds the account. */
  pct: number;
  /** "5h" or "Week". */
  window: "5h" | "Week";
  resetsAt?: string;
  /** Set while a run's limit error holds the account. */
  limit?: AccountLimit;
  estimated: boolean;
}

/**
 * The account of the workspace (every account when `org` is undefined) whose 5-hour or weekly window
 * is fullest. An account held by a limit error counts as full. Undefined when no account has usage.
 */
export function busiestAccount(
  accounts: readonly AccountView[],
  org: string | undefined,
): BusiestAccount | undefined {
  let best: BusiestAccount | undefined;
  for (const account of accounts) {
    if (org !== undefined && account.org !== org) continue;
    const usage = account.usage;
    const windows: { window: "5h" | "Week"; usedPct: number; resetsAt?: string | undefined }[] = [];
    if (usage?.window) windows.push({ window: "5h", ...usage.window });
    if (usage?.weekly) windows.push({ window: "Week", ...usage.weekly });
    let fullest = windows[0];
    for (const w of windows) if (fullest !== undefined && w.usedPct > fullest.usedPct) fullest = w;
    if (fullest === undefined && account.limit === undefined) continue;
    const pct = account.limit ? 100 : (fullest?.usedPct ?? 0);
    if (best !== undefined && pct <= best.pct) continue;
    const resetsAt = account.limit?.until ?? fullest?.resetsAt;
    best = {
      id: account.id,
      pct,
      window: fullest?.window ?? "5h",
      ...(resetsAt === undefined ? {} : { resetsAt }),
      ...(account.limit === undefined ? {} : { limit: account.limit }),
      estimated: usage?.estimated === true,
    };
  }
  return best;
}

/** The top bar readout: "acme-claude 82% · resets 3:40 PM", or "acme-claude at limit until 3:40 PM". */
export function busiestText(b: BusiestAccount, now: number, locale?: string): { head: string; tail: string } {
  if (b.limit) {
    const about = b.limit.resetKnown ? "" : "about ";
    return { head: b.id, tail: `at limit until ${about}${resetLabel(b.limit.until, now, locale)}` };
  }
  const reset = b.resetsAt ? ` · resets ${resetLabel(b.resetsAt, now, locale)}` : "";
  return { head: b.id, tail: `${formatPct(b.pct)}${reset}${b.estimated ? " est." : ""}` };
}

/** One line per account for the readout's tooltip: "acme-claude: 5h 82% · 3:40 PM, Week 31% · Thu". */
export function usageTitle(
  accounts: readonly AccountView[],
  org: string | undefined,
  now: number,
  locale?: string,
): string {
  const lines: string[] = [];
  for (const account of accounts) {
    if (org !== undefined && account.org !== org) continue;
    const parts = usageRows(account.usage, now, locale).map(usageRowText);
    if (account.limit) parts.unshift(limitUntilText(account.limit, now, locale));
    if (parts.length > 0) lines.push(`${account.id}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

/** The auth column: "Signed in", "API key", or what is wrong with the login. */
export function authInfo(account: Pick<AccountView, "status" | "auth">): StatusInfo {
  if (account.auth === "api-key") return { label: "API key", tone: "green" };
  switch (account.status) {
    case "needs-login":
      return { label: "Needs login", tone: "red" };
    case "relogin-soon":
      return { label: "Expires soon", tone: "amber" };
    case "unreachable":
      return { label: "Unreachable", tone: "red" };
    case "unknown":
      return { label: "Not checked", tone: "neutral" };
    default:
      return { label: "Signed in", tone: "green" };
  }
}
