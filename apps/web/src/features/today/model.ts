import {
  AGENDA_KIND_LABEL,
  type AgendaItem,
  type AgendaKind,
  type AgendaTarget,
  DECISION_KIND_LABEL,
  type OwnerDecision,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";
import { rowTitle } from "@/features/decisions/model";
import type { BannerAction } from "@/features/shell/model";

/** Where an agenda item's one action goes. Each target is a place that already exists. */
export function actionOf(target: AgendaTarget): BannerAction {
  switch (target.to) {
    case "decision":
      return { kind: "page", to: "/decisions", search: { id: target.id } };
    case "finding":
      return { kind: "page", to: "/captain", search: { id: String(target.id), tab: "findings" } };
    case "limits":
      return { kind: "page", to: "/limits" };
    case "playbooks":
      return { kind: "page", to: "/playbooks" };
  }
}

/** One lamp per kind. Red means it waits for the owner; magenta that work is on hold; slate that it can wait. */
export function lampOf(item: Pick<AgendaItem, "kind" | "must">): LampState {
  const kind: AgendaKind = item.kind;
  switch (kind) {
    case "incident":
    case "decision":
    case "draft":
    case "finding":
      return "needs";
    case "budget":
      return "paused";
  }
}

/** "5 min", "1 h", "1 h 40 min". */
export function minutesText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** What `e` does with an item, in words, or undefined when the owner cannot finish it from Today. */
export function doneWord(item: Pick<AgendaItem, "done">): string | undefined {
  if (item.done?.kind === "dismiss-finding") return "Dismiss";
  if (item.done?.kind === "ack-incident") return "Acknowledge";
  return undefined;
}

/** "Sat 4 Oct" from the day the server names, in the browser's language. */
export function dayText(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/**
 * The header's one sentence. "Need you" is the Needs you count, the same number as the bell and the Decisions
 * page. Findings and incidents on the agenda that are not decisions are counted apart.
 */
export function subtitleOf(input: {
  day: string;
  needs: number;
  look: number;
  minutes: number;
  later: number;
}): string {
  const date = dayText(input.day);
  const later = input.later > 0 ? `, ${input.later} more later` : "";
  const look = input.look > 0 ? `, ${input.look} to look at` : "";
  if (input.needs === 0) return `${date}. Nothing needs you${look}${later}.`;
  return `${date}. ${input.needs} ${input.needs === 1 ? "thing needs" : "things need"} you, about ${minutesText(input.minutes)}${look}${later}.`;
}

/** What an agenda row calls itself: a decision uses its Decisions kind and title, so both screens agree. */
export function rowLabels(
  item: Pick<AgendaItem, "kind" | "title" | "target">,
  decisions: readonly OwnerDecision[] | undefined,
): { kind: string; title: string } {
  if (item.target.to === "decision") {
    const id = item.target.id;
    const decision = decisions?.find((d) => d.id === id);
    if (decision !== undefined)
      return { kind: DECISION_KIND_LABEL[decision.kind], title: rowTitle(decision) };
  }
  return { kind: AGENDA_KIND_LABEL[item.kind], title: item.title };
}

/** The brief's time on the owner's clock, in the zone the server names. */
export function clockText(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(iso));
  } catch {
    return "";
  }
}

/** The review times the owner picks from. */
export const REVIEW_CHOICES = [15, 30, 45, 60, 90, 120, 180] as const;
