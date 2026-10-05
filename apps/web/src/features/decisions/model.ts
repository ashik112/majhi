import {
  type BoardCounts,
  DECISION_KIND_LABEL,
  type DecisionLink,
  type OwnerDecision,
  type OwnerDecisionKind,
  PRIVATE,
  type WorkCounts,
} from "@majhi/shared";
import type { BannerAction } from "../shell/model";

/**
 * The kinds the filter offers, named by the shared table so a chip and a row say the same word. The
 * server has eight kinds; the owner meets five: an approval, a secret and a sign-in are all access, and
 * the workspace budget and the captain's own budget are both money.
 */
export const KIND_FILTERS = [
  { id: "ship", label: DECISION_KIND_LABEL.ship },
  { id: "question", label: DECISION_KIND_LABEL.question },
  { id: "permission", label: DECISION_KIND_LABEL.approval },
  { id: "access", label: DECISION_KIND_LABEL.secret },
  { id: "money", label: DECISION_KIND_LABEL.budget },
  { id: "paused", label: DECISION_KIND_LABEL.paused },
  { id: "incident", label: DECISION_KIND_LABEL.incident },
  { id: "trust", label: DECISION_KIND_LABEL.trust },
] as const;
export type KindFilter = (typeof KIND_FILTERS)[number]["id"];

const GROUP: Record<OwnerDecisionKind, KindFilter> = {
  ship: "ship",
  question: "question",
  approval: "permission",
  secret: "access",
  "sign-in": "access",
  budget: "money",
  paused: "paused",
  draft: "access",
  batch: "access",
  incident: "incident",
  trust: "trust",
  notifications: "access",
};

export function kindFilterOf(decision: Pick<OwnerDecision, "kind">): KindFilter {
  return GROUP[decision.kind];
}

/** The workspace a decision belongs to: its org, Private for a task of none, nothing for an account or the day's budget. */
export function workspaceOf(decision: Pick<OwnerDecision, "org" | "task">): string | undefined {
  return decision.org ?? (decision.task === undefined ? undefined : PRIVATE);
}

/** The room card a secret decision answers (`room:<task>:<item>`), or undefined for any other decision. */
export function secretCardOf(decision: OwnerDecision): { task: string; item: string } | undefined {
  if (decision.kind !== "secret" || decision.task === undefined) return undefined;
  const prefix = `room:${decision.task}:`;
  return decision.id.startsWith(prefix)
    ? { task: decision.task, item: decision.id.slice(prefix.length) }
    : undefined;
}

/** What the queue shows for a decision: the task's title for work, else the line itself. */
export function rowTitle(decision: OwnerDecision): string {
  if ((decision.kind === "ship" || decision.kind === "paused") && decision.taskTitle !== undefined) {
    return decision.taskTitle;
  }
  return decision.title.replace(/^@\S+ (?:asks|needs approval|needs a secret): /, "");
}

export interface Filters {
  org: string | undefined;
  kind: KindFilter | undefined;
}

export function applyFilters(decisions: readonly OwnerDecision[], f: Filters): OwnerDecision[] {
  return decisions.filter(
    (d) =>
      (f.org === undefined || workspaceOf(d) === f.org) &&
      (f.kind === undefined || kindFilterOf(d) === f.kind),
  );
}

/** Counts per kind, within the workspace filter only, so a kind chip says what it would show. */
export function kindCounts(
  decisions: readonly OwnerDecision[],
  org: string | undefined,
): Map<KindFilter, number> {
  const by = new Map<KindFilter, number>();
  for (const d of decisions) {
    if (org !== undefined && workspaceOf(d) !== org) continue;
    const kind = kindFilterOf(d);
    by.set(kind, (by.get(kind) ?? 0) + 1);
  }
  return by;
}

/** Counts per workspace, within the kind filter only. */
export function workspaceCounts(
  decisions: readonly OwnerDecision[],
  kind: KindFilter | undefined,
): Map<string, number> {
  const by = new Map<string, number>();
  for (const d of decisions) {
    if (kind !== undefined && kindFilterOf(d) !== kind) continue;
    const key = workspaceOf(d);
    if (key !== undefined) by.set(key, (by.get(key) ?? 0) + 1);
  }
  return by;
}

/**
 * Which decision to show after one is answered: the one that followed it in the queue as it was, else
 * the one before it, else none. `before` is the queue when the answer was sent, `left` what waits now.
 */
export function afterAnswer(
  before: readonly string[],
  answered: string,
  left: readonly string[],
): string | undefined {
  const at = before.indexOf(answered);
  const still = new Set(left);
  for (let i = at + 1; i < before.length; i++) {
    const id = before[i];
    if (id !== undefined && still.has(id)) return id;
  }
  for (let i = at - 1; i >= 0; i--) {
    const id = before[i];
    if (id !== undefined && still.has(id)) return id;
  }
  return undefined;
}

/** Where "Open task" and its kin go, as the banner and the bell navigate. */
export function actionOf(link: DecisionLink): BannerAction {
  switch (link.kind) {
    case "task":
      return { kind: "task", id: link.id, ...(link.item === undefined ? {} : { item: link.item }) };
    case "chat":
      return { kind: "chat", id: link.id };
    case "captain":
      return { kind: "page", to: "/captain" };
    case "limits":
      return { kind: "page", to: "/limits" };
    case "account":
      return { kind: "page", to: "/accounts", search: { account: link.id } };
    case "playbooks":
      return { kind: "page", to: "/playbooks" };
    case "watch":
      return { kind: "page", to: "/watch" };
    case "setup":
      return { kind: "page", to: "/setup", search: { section: link.section } };
  }
}

export function openLabel(link: DecisionLink): string {
  switch (link.kind) {
    case "task":
      return "Open task";
    case "chat":
      return "Open chat";
    case "captain":
      return "Open Captain";
    case "limits":
      return "Open Limits";
    case "account":
      return "Sign in";
    case "playbooks":
      return "Open Playbooks";
    case "watch":
      return "Open Watch";
    case "setup":
      return "Open settings";
  }
}

/** The label of a decision's suggested option, for the queue's chip. */
export function suggestedLabel(decision: OwnerDecision): string | undefined {
  const s = decision.suggestion;
  if (s === undefined || s.by !== "captain") return undefined;
  return decision.options.find((o) => o.id === s.option)?.label ?? s.option;
}

/** The first line of the last answer, "Last decision answered 12 min ago." */
export function lastAnswerText(at: string | undefined, ago: (iso: string) => string): string | undefined {
  return at === undefined ? undefined : `Last decision answered ${ago(at)}.`;
}

/**
 * The answer the main button and Enter give: the one marked primary, or the first that can be taken
 * when that one is blocked (Merge with nothing committed leaves Mark done).
 */
export function primaryOption(
  decision: OwnerDecision,
  blocked: Readonly<Record<string, string>> | undefined,
): OwnerDecision["options"][number] | undefined {
  const free = decision.options.filter((o) => blocked?.[o.id] === undefined);
  return free.find((o) => o.primary === true) ?? free.find((o) => o.text !== true) ?? free[0];
}

/**
 * What waits and what works, all workspaces or one. The server counts them (`decisions.list`), so
 * the Home header, its columns, the bell, the sidebar and the banner cannot disagree. Unknown
 * (undefined), not zero, until the list has loaded.
 */
export function workCountsOf(counts: BoardCounts | undefined, org?: string): WorkCounts | undefined {
  if (counts === undefined) return undefined;
  if (org === undefined) return counts;
  return counts.orgs[org] ?? { needsYou: 0, working: 0 };
}

/** The ids from one row to another in the queue, both included, whichever comes first. */
export function rangeIds(queue: readonly string[], from: string | undefined, to: string): string[] {
  const end = queue.indexOf(to);
  if (end < 0) return [];
  const start = from === undefined ? end : queue.indexOf(from);
  if (start < 0) return [to];
  return queue.slice(Math.min(start, end), Math.max(start, end) + 1);
}
