import { type AutonomyEvent, type CaptainAction, PRIVATE } from "@majhi/shared";

/** What the Log tab can filter by. `other` lines (switch changes, wake-ups, guidance) show under All only. */
export type LogKind = "decisions" | "starts" | "ships" | "upkeep" | "holds" | "other";
export type LogFilter = "all" | Exclude<LogKind, "other">;

export const LOG_FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "decisions", label: "Decisions" },
  { value: "starts", label: "Starts" },
  { value: "ships", label: "Ships" },
  { value: "upkeep", label: "Upkeep" },
  { value: "holds", label: "Holds" },
];

/** One line of the merged log: something the captain did or decided, from either record. */
export type LogLine =
  | { source: "captain"; key: string; at: string; org: string; kind: LogKind; action: CaptainAction }
  | {
      source: "autonomy";
      key: string;
      at: string;
      org: string | undefined;
      kind: LogKind;
      event: AutonomyEvent;
    };

const CHORE_KIND: Record<CaptainAction["chore"], LogKind> = {
  ship: "ships",
  cards: "decisions",
  questions: "decisions",
  memory: "upkeep",
  projects: "upkeep",
  triage: "upkeep",
  cleanup: "upkeep",
  stuck: "upkeep",
};

/** Which kind an autonomous event is. A task event is a ship once the task reached review, an MR or done. */
export function eventKind(event: Pick<AutonomyEvent, "kind" | "status" | "text">): LogKind {
  switch (event.kind) {
    case "decision":
    case "approval":
    case "refused":
    case "answer":
      return "decisions";
    case "cap":
      return "holds";
    case "task":
      if (event.status === "review" || event.status === "mr" || event.status === "done") return "ships";
      return /\bwaits\b/.test(event.text) ? "holds" : "starts";
    default:
      return "other";
  }
}

/**
 * Both records in one list, newest first. An event with no workspace belongs to Private, except the
 * ones about the whole captain (switch changes, wake-ups, summaries), which belong to none.
 */
export function mergeLog(actions: readonly CaptainAction[], events: readonly AutonomyEvent[]): LogLine[] {
  const lines: LogLine[] = [
    ...actions.map<LogLine>((action) => ({
      source: "captain",
      key: `c${action.id}`,
      at: action.at,
      org: action.org,
      kind: CHORE_KIND[action.chore],
      action,
    })),
    ...events.map<LogLine>((event) => ({
      source: "autonomy",
      key: `e${event.seq}`,
      at: event.at,
      org:
        event.org ??
        (event.kind === "mode" || event.kind === "summary" || event.kind === "tick" ? undefined : PRIVATE),
      kind: eventKind(event),
      event,
    })),
  ];
  return lines.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Whether a line shows under a workspace ("" is all of them) and a kind filter. */
export function inLogView(line: Pick<LogLine, "org" | "kind">, org: string, filter: LogFilter): boolean {
  if (org !== "" && line.org !== org) return false;
  return filter === "all" || line.kind === filter;
}
