import type {
  AutomationAction,
  AutomationRun,
  AutomationRunStatus,
  ScheduleSpec,
  WatchSpec,
} from "@majhi/shared";
import type { LampState } from "@/components/ui/lamp";

// Time zones ----------------------------------------------------------------

/** The browser's own zone. New schedules are made in it and it is sent with them. */
export const BROWSER_ZONE: string = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Every zone the browser knows, the browser's and UTC first. */
export function zoneOptions(extra?: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const first = [BROWSER_ZONE, "UTC", ...(extra === undefined ? [] : [extra])];
  return [...new Set([...first, ...all])];
}

const WHEN: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};

/** "Thu 2 Oct, 09:00 CEST": a UTC instant on the wall clock of `zone`, with the zone's short name. */
export function formatInZone(iso: string, zone: string): string {
  return new Intl.DateTimeFormat(undefined, { ...WHEN, timeZone: zone, timeZoneName: "short" }).format(
    new Date(iso),
  );
}

/** The same instant on the browser's clock when it reads differently from `zone`'s, else undefined. */
export function yourTime(iso: string, zone: string): string | undefined {
  const there = new Intl.DateTimeFormat(undefined, { ...WHEN, timeZone: zone }).format(new Date(iso));
  const here = new Intl.DateTimeFormat(undefined, { ...WHEN, timeZone: BROWSER_ZONE }).format(new Date(iso));
  return there === here ? undefined : formatInZone(iso, BROWSER_ZONE);
}

/** "in 12 min", "in 3 h", "in 2 days", "due now". */
export function formatIn(iso: string, now: number): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (seconds < 45) return "due now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} days`;
}

/** A start and end time as one short span: "4 min", "1.2 s". */
export function runSpan(run: AutomationRun): string | undefined {
  if (run.endedAt === null) return undefined;
  const ms = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (ms < 1000) return "under 1 s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
}

// Specs ---------------------------------------------------------------------

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const unitWord = (unit: "minutes" | "hours" | "days", n: number): string => {
  const one = unit.slice(0, -1);
  return n === 1 ? one : unit;
};

/**
 * A spec as a phrase the phrase parser reads back ("every 30 minutes", "weekdays at 9:00"), or
 * undefined for a cron expression or a one-off that has no phrase.
 */
export function specToPhrase(spec: ScheduleSpec): string | undefined {
  if (spec.kind === "interval") {
    return spec.every === 1 ? `every ${unitWord(spec.unit, 1)}` : `every ${spec.every} ${spec.unit}`;
  }
  if (spec.kind !== "cron") return undefined;
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|[0-6](?:,[0-6])*)$/.exec(spec.expression.trim());
  if (m === null) return undefined;
  const time = `${Number(m[2])}:${String(Number(m[1])).padStart(2, "0")}`;
  const days = m[3];
  if (days === "*") return `daily at ${time}`;
  if (days === "1-5") return `weekdays at ${time}`;
  if (days === "0,6") return `weekends at ${time}`;
  const names = (days ?? "").split(",").map((d) => `${DAY_NAMES[Number(d)]}s`);
  return `${names.join(" and ")} at ${time}`;
}

/** What the list says about when a schedule runs. */
export function describeSpec(spec: ScheduleSpec): string {
  const phrase = specToPhrase(spec);
  if (phrase !== undefined) return phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return spec.kind === "once" ? `Once, ${spec.at.replace("T", " ")}` : "On a cron schedule";
}

/** The cron expression or one-off time behind a phrase, shown in mono beside it. */
export function specCode(spec: ScheduleSpec): string | undefined {
  if (spec.kind === "cron") return spec.expression;
  if (spec.kind === "once") return spec.at;
  return undefined;
}

// Actions and runs ----------------------------------------------------------

const clip = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What an action does, in words. */
export function describeAction(action: AutomationAction): string {
  switch (action.kind) {
    case "task.start":
      return `Start a task in ${action.project}: ${clip(action.title, 60)}`;
    case "room.post":
      return `Post to ${action.task}: ${clip(action.text, 60)}`;
    case "process.run":
      return `Run ${clip(action.command, 50)} in ${action.task}`;
    case "tasks.resume":
      return "Resume the tasks a limit paused";
  }
}

export const RUN_STATUS: Record<AutomationRunStatus, { lamp: LampState; label: string }> = {
  running: { lamp: "working", label: "Running" },
  ok: { lamp: "done", label: "OK" },
  failed: { lamp: "needs", label: "Failed" },
  skipped: { lamp: "idle", label: "Skipped" },
};

/** The task or process a run made, as a link target: the room, and a process id in it. */
export function runTarget(run: AutomationRun): { task: string; process: string | null } | undefined {
  return run.taskId === null ? undefined : { task: run.taskId, process: run.processId };
}

// Watches -------------------------------------------------------------------

export const WATCH_KINDS: readonly { kind: WatchSpec["kind"]; label: string }[] = [
  { kind: "task.status", label: "A task changes status" },
  { kind: "mr.changed", label: "A merge request changes" },
  { kind: "branch.changed", label: "A branch moves" },
  { kind: "path.changed", label: "A file or folder changes" },
  { kind: "process.exit", label: "A process exits" },
  { kind: "usage.over", label: "Usage crosses a limit" },
  { kind: "url.changed", label: "A URL changes" },
  { kind: "command.changed", label: "A command's output changes" },
];

/** "1 min", "5 min", "2 h", "45 s". */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round((seconds / 3600) * 10) / 10} h`;
}
