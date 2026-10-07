import type { AgendaItem, AgendaToday, Finding, OwnerDecision, OwnerDecisionKind } from "@majhi/shared";
import { ageWord } from "./time.ts";

/**
 * The agenda (SPEC 5.18): one ordered list from what already exists, computed in code. Pure: every input is
 * passed in, so the order, the ties and the review budget are tested without a database.
 */

export interface AgendaInput {
  now: Date;
  tz: string;
  decisions: readonly OwnerDecision[];
  /** Findings that are live. Only open ones of high severity (and incidents) make the agenda. */
  findings: readonly Finding[];
  /** A workspace's name by id; undefined reads as the id. */
  orgName: (org: string | undefined) => string | undefined;
}

/** Minutes the owner is estimated to need for a decision. Cheap to answer ones are 1, a ship to read is 3. */
const DECISION_MINUTES: Record<OwnerDecisionKind, number> = {
  ship: 3,
  question: 2,
  approval: 1,
  budget: 1,
  paused: 1,
  "sign-in": 2,
  secret: 1,
  draft: 2,
  reply: 1,
  batch: 3,
  trust: 1,
  notifications: 1,
  incident: 1,
};

/** The order of decisions among themselves: what blocks an agent first, then what is ready to ship. */
const DECISION_WEIGHT: Record<OwnerDecisionKind, number> = {
  "sign-in": 56,
  question: 55,
  secret: 54,
  approval: 52,
  ship: 50,
  paused: 48,
  draft: 45,
  reply: 46,
  batch: 44,
  // A row that went back to You, or a promotion proposal: read when there is time.
  trust: 40,
  // The owner's own switch on the Mac: until it is on, desktop alerts do not show.
  notifications: 53,
  // An incident decision is left out of the agenda: its finding stands for it, with the same weight.
  incident: 100,
  // A budget hold is handled below: it stops new work.
  budget: 85,
};

/** A waiting item gains up to this much weight over two days, so older ones go first within a kind. */
const AGE_BONUS = 10;
const AGE_FULL_HOURS = 48;

/** The weight of an incident and of a finding. */
const W = {
  incident: 100,
  finding: 62,
} as const;

function ageBonus(at: string, now: Date): number {
  const hours = Math.max(0, (now.getTime() - new Date(at).getTime()) / 3_600_000);
  return Math.min(1, hours / AGE_FULL_HOURS) * AGE_BONUS;
}

function named(org: string | undefined, orgName: AgendaInput["orgName"]) {
  const name = org === undefined ? undefined : orgName(org);
  return {
    ...(org === undefined ? {} : { org }),
    ...(name === undefined ? {} : { orgName: name }),
  };
}

function decisionItem(d: OwnerDecision, input: AgendaInput): AgendaItem {
  const waited = ageWord(d.at, input.now);
  const hold = d.kind === "budget";
  const kind = hold ? "budget" : d.kind === "draft" || d.kind === "batch" ? "draft" : "decision";
  const why =
    d.kind === "ship"
      ? `Ready to ship, waiting ${waited}`
      : hold
        ? "New work is on hold until you answer"
        : d.kind === "sign-in"
          ? `An account is signed out, waiting ${waited}`
          : d.kind === "draft" || d.kind === "batch"
            ? `A draft waits for you, ${waited}`
            : `Waiting ${waited}`;
  const action =
    d.kind === "ship"
      ? "Ship"
      : hold
        ? "Answer"
        : d.kind === "draft" || d.kind === "batch"
          ? "Review"
          : d.kind === "sign-in"
            ? "Sign in"
            : "Answer";
  return {
    id: `decision:${d.id}`,
    kind,
    ...named(d.org, input.orgName),
    title: d.title,
    why,
    action,
    target: { to: "decision", id: d.id },
    minutes: DECISION_MINUTES[d.kind],
    weight: DECISION_WEIGHT[d.kind] + (hold ? 0 : ageBonus(d.at, input.now)),
    at: d.at,
    must: false,
  };
}

function findingItem(f: Finding, input: AgendaInput): AgendaItem | undefined {
  if (f.status !== "open") return undefined;
  const incident = f.source === "incident";
  // Only what matters today: an incident of any severity above info, or a high finding.
  if (!incident && f.severity !== "high") return undefined;
  if (incident && f.severity === "info") return undefined;
  return {
    id: `finding:${f.id}`,
    kind: incident ? "incident" : "finding",
    ...named(f.org, input.orgName),
    title: f.title,
    why: incident
      ? `Open incident, first seen ${ageWord(f.createdAt, input.now)} ago`
      : "High severity, nobody has taken it",
    action: incident ? "Open" : "Review",
    target: { to: "finding", id: f.id },
    minutes: incident ? 10 : 5,
    weight: incident ? W.incident : W.finding + ageBonus(f.createdAt, input.now),
    at: f.createdAt,
    must: incident,
    done: { kind: "dismiss-finding", id: f.id },
  };
}

/** Highest weight first; then the older moment; then the id, so the same input is always the same order. */
export function compareItems(a: AgendaItem, b: AgendaItem): number {
  if (b.weight !== a.weight) return b.weight - a.weight;
  const ta = a.at === undefined ? Number.POSITIVE_INFINITY : new Date(a.at).getTime();
  const tb = b.at === undefined ? Number.POSITIVE_INFINITY : new Date(b.at).getTime();
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Every item that could be on the agenda, in order. */
export function buildItems(input: AgendaInput): AgendaItem[] {
  const items: AgendaItem[] = [
    ...input.decisions.filter((d) => d.kind !== "incident").map((d) => decisionItem(d, input)),
    ...input.findings.flatMap((f) => findingItem(f, input) ?? []),
  ];
  return items.sort(compareItems);
}

export interface Planned {
  today: AgendaItem[];
  later: AgendaItem[];
  usedMinutes: number;
  laterMinutes: number;
  over: boolean;
}

/**
 * Cuts the ordered list at the owner's review budget. An item that must happen today (an incident
 * due today or overdue) is always today, even past the budget. Otherwise items go in order while they fit; the
 * first that does not fit ends today and everything after it is later, so the order stays the order. When
 * nothing fit at all, the first item is still today: the page never says "later" to everything.
 */
export function plan(items: readonly AgendaItem[], budgetMinutes: number): Planned {
  const today: AgendaItem[] = [];
  const later: AgendaItem[] = [];
  let used = 0;
  let full = false;
  for (const item of items) {
    if (item.must) {
      today.push(item);
      used += item.minutes;
    } else if (!full && used + item.minutes <= budgetMinutes) {
      today.push(item);
      used += item.minutes;
    } else {
      full = true;
      later.push(item);
    }
  }
  if (today.length === 0 && later.length > 0) {
    const first = later.shift() as AgendaItem;
    today.push(first);
    used += first.minutes;
  }
  return {
    today,
    later,
    usedMinutes: used,
    laterMinutes: later.reduce((n, i) => n + i.minutes, 0),
    over: used > budgetMinutes,
  };
}

/** The items of one workspace and the business's own. */
export function inScope<T extends { org?: string | undefined }>(
  items: readonly T[],
  org: string | undefined,
): T[] {
  return org === undefined ? [...items] : items.filter((i) => i.org === undefined || i.org === org);
}

export type PlannedToday = Pick<AgendaToday, "today" | "later" | "usedMinutes" | "laterMinutes" | "over">;
