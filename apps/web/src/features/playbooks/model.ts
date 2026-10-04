import {
  type Cadence,
  PLAYBOOK_PACKS,
  type PlaybookCounters,
  type PlaybookPack,
  type PlaybookRun,
  type PlaybookView,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

/** Playbooks grouped by pack, in the pack order, each group in the catalog's order. Empty packs are left out. */
export function byPack(views: readonly PlaybookView[]): { pack: PlaybookPack; views: PlaybookView[] }[] {
  return PLAYBOOK_PACKS.map((pack) => ({
    pack,
    views: views.filter((v) => v.playbook.pack === pack),
  })).filter((g) => g.views.length > 0);
}

/** "in 12 min", "in 3 h", "tomorrow 08:00" style: how long until an ISO time, from `now`. */
export function formatIn(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.round((then - now) / 1000);
  if (seconds < 90) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} h`;
  return new Date(then).toLocaleDateString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** What came of the runs, in a few words: "3 findings, 2 taken, 1 dismissed" or "did 14 things". */
export function outcomeText(c: PlaybookCounters): string {
  if (c.ran === 0) return "Has not run";
  const parts: string[] = [];
  if (c.findings > 0) {
    parts.push(`${c.findings} ${c.findings === 1 ? "finding" : "findings"}`);
    if (c.accepted > 0) parts.push(`${c.accepted} taken`);
    if (c.dismissed > 0) parts.push(`${c.dismissed} dismissed`);
  } else if (c.acted > 0) {
    parts.push(`${c.acted} ${c.acted === 1 ? "action" : "actions"}`);
  }
  const ran = `${c.ran} ${c.ran === 1 ? "run" : "runs"}`;
  return parts.length === 0 ? `${ran}, nothing to report` : `${ran}: ${parts.join(", ")}`;
}

export type CadenceKind = Cadence["kind"] | "hourly" | "quarter";

/** The choices of the cadence menu. Hourly and every 15 minutes are `every` with a fixed number. */
export const CADENCE_CHOICES: readonly { id: string; label: string }[] = [
  { id: "events", label: "When something happens" },
  { id: "every-5", label: "Every 5 minutes" },
  { id: "every-15", label: "Every 15 minutes" },
  { id: "every-60", label: "Every hour" },
  { id: "every-360", label: "Every 6 hours" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "manual", label: "On demand" },
];

export function choiceOf(c: Cadence): string {
  if (c.kind === "every") {
    return CADENCE_CHOICES.some((x) => x.id === `every-${c.minutes}`) ? `every-${c.minutes}` : "every-60";
  }
  return c.kind;
}

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The cadence a menu choice means, keeping a time already set. */
export function cadenceFrom(choice: string, prev: Cadence): Cadence {
  const at = prev.kind === "daily" || prev.kind === "weekly" ? prev.at : "08:00";
  if (choice.startsWith("every-")) return { kind: "every", minutes: Number(choice.slice(6)) };
  if (choice === "daily") return { kind: "daily", at };
  if (choice === "weekly") return { kind: "weekly", day: prev.kind === "weekly" ? prev.day : 1, at };
  return choice === "events" ? { kind: "events" } : { kind: "manual" };
}

/** The kinds the page filters by: Upkeep, Code health (the engineering and ops packs) and Business (business and growth). */
export type Kind = "upkeep" | "code" | "business";
export const KINDS: readonly Kind[] = ["upkeep", "code", "business"];
export const KIND_LABEL: Record<Kind, string> = {
  upkeep: "Upkeep",
  code: "Code health",
  business: "Business",
};

export function kindOf(pack: PlaybookPack): Kind {
  if (pack === "upkeep") return "upkeep";
  return pack === "engineering" || pack === "ops" ? "code" : "business";
}

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** How often it runs, in a few plain words: "every hour", "daily 02:30", "weekly Mon", "when it happens". */
export function cadenceWords(c: Cadence): string {
  switch (c.kind) {
    case "manual":
      return "on demand";
    case "events":
      return "when it happens";
    case "every":
      if (c.minutes === 60) return "every hour";
      if (c.minutes % 60 === 0) return `every ${c.minutes / 60} h`;
      return `every ${c.minutes} min`;
    case "daily":
      return c.at === "00:00" ? "daily" : `daily ${c.at}`;
    case "weekly":
      return `weekly ${DAY_SHORT[c.day]}`;
  }
}

/** "08:00" for a time today, else the weekday and the day: when the last run happened. */
export function shortWhen(iso: string, now: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date(now).toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return today ? hm : `${d.toLocaleDateString([], { weekday: "short" })} ${hm}`;
}

/** The daily limits the menu offers, besides "No cap". */
export const LIMIT_CHOICES: readonly number[] = [1, 3, 5, 10, 20, 40, 100];

export const RUN_LAMP: Record<PlaybookRun["status"], LampState> = {
  running: "working",
  done: "done",
  nothing: "idle",
  failed: "needs",
  capped: "paused",
  stopped: "paused",
};

export const RUN_WORD: Record<PlaybookRun["status"], string> = {
  running: "Running",
  done: "Done",
  nothing: "Nothing new",
  failed: "Failed",
  capped: "Hit its budget",
  stopped: "Stopped",
};
