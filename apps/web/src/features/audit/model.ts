import { type AuditDecision, AuditDecisionSchema, type AuditEntry, TaskIdSchema } from "@majhi/shared";
import type { DotTone } from "@/components/ui/status-dot";

/** The filters of the audit page, as the address holds them. Every field is optional. */
export interface AuditFilters {
  org?: string;
  task?: string;
  kinds?: string[];
  agent?: string;
  decision?: AuditDecision;
  /** A day, `2026-10-01`. */
  from?: string;
  to?: string;
}

/** The search params the page reads: `scope` is the org, `about` the task, `who` the agent. */
export interface AuditSearch {
  scope?: string;
  about?: string;
  who?: string;
  kinds?: string;
  decision?: string;
  from?: string;
  to?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const DECISIONS = AuditDecisionSchema.options;

export function filtersFromSearch(search: AuditSearch): AuditFilters {
  const kinds = (search.kinds ?? "").split(",").filter((k) => k !== "");
  const decision = AuditDecisionSchema.safeParse(search.decision).data;
  return {
    ...(search.scope ? { org: search.scope } : {}),
    ...(search.about ? { task: search.about } : {}),
    ...(search.who ? { agent: search.who } : {}),
    ...(kinds.length > 0 ? { kinds } : {}),
    ...(decision ? { decision } : {}),
    ...(search.from && DAY.test(search.from) ? { from: search.from } : {}),
    ...(search.to && DAY.test(search.to) ? { to: search.to } : {}),
  };
}

export function searchFromFilters(filters: AuditFilters): AuditSearch {
  return {
    ...(filters.org ? { scope: filters.org } : {}),
    ...(filters.task ? { about: filters.task } : {}),
    ...(filters.agent ? { who: filters.agent } : {}),
    ...(filters.kinds && filters.kinds.length > 0 ? { kinds: filters.kinds.join(",") } : {}),
    ...(filters.decision ? { decision: filters.decision } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
}

export function hasFilters(filters: AuditFilters): boolean {
  return Object.keys(filters).length > 0;
}

/** A task id the server will accept, or undefined while the text is not one yet. */
export function validTask(text: string): string | undefined {
  return TaskIdSchema.safeParse(text.trim().toUpperCase()).data;
}

/** The start of a local day as a time, so the filter matches the times the table shows. */
function dayStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).toISOString();
}

function dayEnd(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999).toISOString();
}

/** What `audit.list` takes for these filters, without the paging. */
export function listInput(filters: AuditFilters) {
  return {
    ...(filters.org ? { org: filters.org } : {}),
    ...(filters.task ? { task: filters.task } : {}),
    ...(filters.kinds && filters.kinds.length > 0 ? { kinds: filters.kinds } : {}),
    ...(filters.agent ? { agent: filters.agent } : {}),
    ...(filters.decision ? { decision: filters.decision } : {}),
    ...(filters.from ? { from: dayStart(filters.from) } : {}),
    ...(filters.to ? { to: dayEnd(filters.to) } : {}),
  };
}

const KIND_LABELS: Record<string, string> = {
  push: "Push",
  mr: "Merge request",
  merge: "Merge",
  "merge+push": "Push after merge",
  ship: "Resolve and merge",
  cleanup: "Cleanup",
  "tasks.start": "Lead start",
};

/** A kind in words when majhi knows it, else as logged (a command name or a tool kind). */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export const DECISION_LABELS: Record<AuditDecision, string> = {
  allow: "Allowed",
  deny: "Denied",
  cancelled: "Cancelled",
  done: "Done",
  failed: "Failed",
};

export function decisionTone(decision: AuditEntry["decision"]): DotTone {
  if (decision === "allow" || decision === "done") return "green";
  if (decision === "deny" || decision === "failed") return "red";
  return "neutral";
}

export interface DetailPart {
  text: string;
  /** Set for a web address. */
  href?: string;
}

/** A detail line cut into plain text and web addresses, so a merge request link can be clicked. */
export function detailParts(detail: string): DetailPart[] {
  const parts: DetailPart[] = [];
  let at = 0;
  for (const match of detail.matchAll(/https?:\/\/[^\s)]+/g)) {
    const start = match.index ?? 0;
    // A full stop or comma after a link belongs to the sentence.
    const url = match[0].replace(/[.,;:]+$/, "");
    if (start > at) parts.push({ text: detail.slice(at, start) });
    parts.push({ text: url, href: url });
    at = start + url.length;
  }
  if (at < detail.length) parts.push({ text: detail.slice(at) });
  return parts;
}

/** The table's time column: local and short, with the year only when it is not this one. The title carries the full ISO time. */
export function timeText(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  });
}
