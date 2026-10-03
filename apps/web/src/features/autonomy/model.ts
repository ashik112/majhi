import type {
  AutonomyEvent,
  AutonomyEventKind,
  AutonomyMode,
  AutonomyPatch,
  AutonomyPick,
  AutonomySettings,
  AutonomySummary,
  Budget,
  CapUse,
  TaskPriority,
  TaskSize,
  TaskSizeLimit,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import { readStored, writeStored } from "@/features/memory/storage";
import { parseDollars, parseTokens } from "@/features/usage/budget-model";
import { formatMoney, formatTokens } from "@/lib/format";

// The mode ------------------------------------------------------------------

export const MODE_WORD: Record<AutonomyMode, string> = {
  off: "Off",
  on: "On",
  paused: "Paused",
  stopping: "Stopping",
};

/** On and stopping are running work; paused is the paused lamp; off is idle. */
export const MODE_LAMP: Record<AutonomyMode, LampState> = {
  off: "idle",
  on: "working",
  paused: "paused",
  stopping: "working",
};

/** One line under the page title. */
export function modeLine(mode: AutonomyMode): string {
  switch (mode) {
    case "off":
      return "The captain works only when you ask it to.";
    case "on":
      return "The captain runs the desk: it picks work, decides within your limits and logs every decision.";
    case "paused":
      return "Paused. The captain gets no wake-ups and autonomous tasks wait after their current turn.";
    case "stopping":
      return "Stopping. Current turns finish, nothing new starts, then it turns off.";
  }
}

// Spend ---------------------------------------------------------------------

/** "$4.20 of $20.00", "1.2M of 5M tokens", both with both caps, or what was spent without a cap. */
export function capText(use: CapUse): string {
  const parts: string[] = [];
  if (use.cap?.cost !== undefined)
    parts.push(`${formatMoney(use.used.cost)} of ${formatMoney(use.cap.cost)}`);
  if (use.cap?.tokens !== undefined)
    parts.push(`${formatTokens(use.used.tokens)} of ${formatTokens(use.cap.tokens)} tokens`);
  if (parts.length === 0) parts.push(formatMoney(use.used.cost), `${formatTokens(use.used.tokens)} tokens`);
  return parts.join(" · ");
}

/** "$20.00 a day", "5M tokens a day", "$20.00 or 5M tokens a day". */
export function budgetText(budget: Budget | undefined, per = "a day"): string {
  if (budget === undefined) return "No cap of its own";
  const parts = [
    ...(budget.cost === undefined ? [] : [formatMoney(budget.cost)]),
    ...(budget.tokens === undefined ? [] : [`${formatTokens(budget.tokens)} tokens`]),
  ];
  return `${parts.join(" or ")} ${per}`;
}

/** Calm under 80 %, amber from 80 %, red at the cap. */
export function capTone(use: Pick<CapUse, "percent" | "reached">): "calm" | "amber" | "red" {
  if (use.reached || use.percent >= 100) return "red";
  return use.percent >= 80 ? "amber" : "calm";
}

// The feed ------------------------------------------------------------------

export const EVENT_WORD: Record<AutonomyEventKind, string> = {
  mode: "Mode",
  tick: "Woke",
  decision: "Decision",
  approval: "Approval",
  refused: "Refused",
  task: "Task",
  answer: "Answer",
  guide: "Guidance",
  cap: "Limit",
  summary: "Summary",
};

export type Tone = "neutral" | "amber" | "blue" | "green" | "red";

/** The badge tone of an event: its outcome when it has one, else its kind. */
export function eventTone(event: Pick<AutonomyEvent, "kind" | "outcome">): Tone {
  if (event.outcome === "applied") return "green";
  if (event.outcome === "left") return "amber";
  if (event.outcome === "refused" || event.outcome === "failed" || event.kind === "refused") return "red";
  if (event.kind === "cap") return "amber";
  if (event.kind === "guide" || event.kind === "decision") return "blue";
  return "neutral";
}

const OUTCOME_WORD = {
  applied: "applied",
  left: "left for you",
  refused: "refused",
  failed: "failed",
} as const;

export function outcomeWord(outcome: NonNullable<AutonomyEvent["outcome"]>): string {
  return OUTCOME_WORD[outcome];
}

/** "14:02" today, "Tue 14:02" before. */
export function clockTime(iso: string, now: number): string {
  const at = new Date(iso);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return at.toLocaleString(undefined, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

// The daily summary ----------------------------------------------------------

export const HOW_WORD: Record<AutonomySummary["shipped"][number]["how"], string> = {
  merged: "Merged",
  pushed: "Pushed",
  "mr-open": "MR open",
  "mr-merged": "MR merged",
  review: "Ready for review",
  done: "Done",
};

const SEEN_KEY = "majhi.autonomy.summary-seen";

/** The day of the newest summary the owner has opened on the Autonomous page. */
export function seenSummary(): string | undefined {
  return readStored(SEEN_KEY);
}

export function markSummarySeen(day: string): void {
  writeStored(SEEN_KEY, day);
}

// Tasks ---------------------------------------------------------------------

export const PRIORITY_WORD: Record<TaskPriority, string> = { high: "High", normal: "Normal", low: "Low" };

/** The local calendar day of `now`, `YYYY-MM-DD`. */
export function localDay(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "due today", "due tomorrow", "due Oct 3", "overdue 2 days". `late` is true for a day before today. */
export function dueText(due: string, now: number): { text: string; late: boolean; soon: boolean } {
  const today = Date.parse(`${localDay(now)}T00:00:00`);
  const day = Date.parse(`${due}T00:00:00`);
  const days = Math.round((day - today) / 86_400_000);
  if (Number.isNaN(days)) return { text: `due ${due}`, late: false, soon: false };
  if (days < 0) return { text: `overdue ${-days} ${days === -1 ? "day" : "days"}`, late: true, soon: true };
  if (days === 0) return { text: "due today", late: false, soon: true };
  if (days === 1) return { text: "due tomorrow", late: false, soon: true };
  const label = new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { text: `due ${label}`, late: false, soon: false };
}

// The limits form -------------------------------------------------------------

export interface CapDraft {
  cost: string;
  tokens: string;
}

export interface OrgDraft extends CapDraft {
  push: boolean;
  merge: boolean;
}

export interface LimitsDraft {
  day: CapDraft;
  orgs: Record<string, OrgDraft>;
  window: string;
  weekly: string;
  summaryAt: string;
}

const capDraft = (budget: Budget | undefined): CapDraft => ({
  cost: budget?.cost === undefined ? "" : String(budget.cost),
  tokens: budget?.tokens === undefined ? "" : String(budget.tokens),
});

/** The form as the settings stand, with a row for every org given (and any org the settings name). */
export function limitsDraft(settings: AutonomySettings, orgIds: readonly string[]): LimitsDraft {
  const orgs: Record<string, OrgDraft> = {};
  for (const id of [...orgIds, ...Object.keys(settings.orgs)]) {
    const org = settings.orgs[id];
    orgs[id] = { ...capDraft(org?.cap), push: org?.push ?? false, merge: org?.merge ?? false };
  }
  return {
    day: capDraft(settings.day),
    orgs,
    window: String(settings.floors.window),
    weekly: String(settings.floors.weekly),
    summaryAt: settings.summary_at,
  };
}

function parseCap(draft: CapDraft, label: string): { budget?: Budget; problem?: string } {
  const cost = draft.cost.trim() === "" ? undefined : parseDollars(draft.cost);
  const tokens = draft.tokens.trim() === "" ? undefined : parseTokens(draft.tokens);
  if (draft.cost.trim() !== "" && cost === undefined) return { problem: `${label}: use dollars, like 20.` };
  if (draft.tokens.trim() !== "" && tokens === undefined)
    return { problem: `${label}: use tokens like 500k or 2M.` };
  if (cost === undefined && tokens === undefined) return {};
  return { budget: { ...(cost === undefined ? {} : { cost }), ...(tokens === undefined ? {} : { tokens }) } };
}

function parsePercent(text: string, label: string): { value?: number; problem?: string } {
  const n = Number(text.trim());
  if (text.trim() === "" || !Number.isInteger(n) || n < 0 || n > 100)
    return { problem: `${label}: use a whole percent from 0 to 100.` };
  return { value: n };
}

const sameBudget = (a: Budget | undefined, b: Budget | undefined) =>
  a?.cost === b?.cost && a?.tokens === b?.tokens;

/**
 * The `autonomy.configure` input for what the form changed, or the first problem in it. Only rows
 * that changed are sent; an org left with no cap and push and merge off is removed (null). The
 * browser's zone always goes along, so the day and the summary time follow the owner's clock.
 */
export function limitsPatch(
  draft: LimitsDraft,
  settings: AutonomySettings,
  tz: string,
): { patch: AutonomyPatch } | { problem: string } {
  const day = parseCap(draft.day, "Day cap");
  if (day.problem) return { problem: day.problem };
  if (!day.budget) return { problem: "Day cap: set dollars, tokens or both. It is always on." };
  const window = parsePercent(draft.window, "5-hour floor");
  if (window.problem !== undefined || window.value === undefined) return { problem: window.problem ?? "" };
  const weekly = parsePercent(draft.weekly, "Weekly floor");
  if (weekly.problem !== undefined || weekly.value === undefined) return { problem: weekly.problem ?? "" };
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.summaryAt))
    return { problem: "Summary time: use a time like 08:00." };

  const patch: AutonomyPatch = { tz };
  if (!sameBudget(day.budget, settings.day)) patch.day = day.budget;
  const orgs: NonNullable<AutonomyPatch["orgs"]> = {};
  for (const [id, row] of Object.entries(draft.orgs)) {
    const cap = parseCap(row, `Cap of ${id}`);
    if (cap.problem) return { problem: cap.problem };
    const was = settings.orgs[id];
    const same =
      sameBudget(cap.budget, was?.cap) &&
      row.push === (was?.push ?? false) &&
      row.merge === (was?.merge ?? false);
    if (same) continue;
    orgs[id] =
      cap.budget === undefined && !row.push && !row.merge
        ? null
        : { cap: cap.budget ?? null, push: row.push, merge: row.merge };
  }
  if (Object.keys(orgs).length > 0) patch.orgs = orgs;
  if (window.value !== settings.floors.window || weekly.value !== settings.floors.weekly)
    patch.floors = { window: window.value, weekly: weekly.value };
  if (draft.summaryAt !== settings.summary_at) patch.summary_at = draft.summaryAt;
  return { patch };
}

// The pick rules ------------------------------------------------------------

export const SIZE_LIMIT_WORD: Record<TaskSizeLimit, string> = {
  small: "Small only",
  medium: "Up to medium",
  any: "Any size",
};

export const SIZE_WORD: Record<TaskSize, string> = { small: "Small", medium: "Medium", large: "Large" };

export interface PickDraft {
  size: TaskSizeLimit;
}

export function pickDraft(pick: AutonomyPick): PickDraft {
  return { size: pick.size };
}

/** The `autonomy.configure` input for the pick rules, or undefined when nothing changed. */
export function pickPatch(draft: PickDraft, pick: AutonomyPick): AutonomyPatch | undefined {
  return draft.size === pick.size ? undefined : { pick: { size: draft.size } };
}

// The log --------------------------------------------------------------------

export type LogFilter = "all" | "decisions" | "tasks";

/** Whether an event belongs in the log under this filter. Decisions are filtered by the server. */
export function inLog(event: Pick<AutonomyEvent, "kind">, filter: LogFilter): boolean {
  if (filter === "tasks") return event.kind === "task";
  return true;
}
