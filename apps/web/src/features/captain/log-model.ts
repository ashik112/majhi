import { type AutonomyEvent, type CaptainAction, PRIVATE } from "@majhi/shared";
import { eventTone, type Tone } from "@/features/autonomy/model";

/** What the log can filter by. `other` lines (switch changes, guidance) show under All only. */
export type LogKind = "decisions" | "starts" | "ships" | "upkeep" | "holds" | "other";
export type LogFilter = "all" | Exclude<LogKind, "other">;

export const LOG_FILTERS: readonly { value: LogFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "decisions", label: "Answers" },
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
  followups: "upkeep",
  discover: "upkeep",
  tidy: "upkeep",
  health: "upkeep",
  checklist: "upkeep",
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

/** Events about the whole captain (the switch, wake-ups, summaries) belong to no workspace. */
const WHOLE = new Set<AutonomyEvent["kind"]>(["mode", "summary", "tick"]);

/**
 * Both records in one list, newest first. An event with no workspace belongs to Private, except the
 * ones about the whole captain, which belong to none.
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
      org: event.org ?? (WHOLE.has(event.kind) ? undefined : PRIVATE),
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

// Sentences ------------------------------------------------------------------

/** What the page knows about tasks, to put a title where the log had an id. */
export interface TaskNames {
  /** The title of a task, or undefined when it is unknown. */
  title(id: string): string | undefined;
  /** A chat (the captain's own threads included) is not work: it has no line. */
  isChat(id: string): boolean;
}

const MAX_TITLE = 72;
const ID = String.raw`(?<![/\w-])[A-Z][A-Z0-9]{1,5}-\d+(?![\w-])`;
const WITH_ID = new RegExp(String.raw`^(.*?)(${ID})([^:]*?)(?:: (.+))?$`, "s");
const OLD_TASK = new RegExp(
  String.raw`^(${ID}) (is ready for review|has a merge request open|is done|is running|paused \(([^)]*)\)): (.+)$`,
  "s",
);

function quote(title: string): string {
  const t = title.trim().replace(/\s+/g, " ");
  return `'${t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t}'`;
}

/** "the owner" reads as "you" to the owner. */
function toYou(text: string): string {
  return text.replace(/\bthe owner's\b/gi, "your").replace(/\bthe owner\b/gi, "you");
}

/** Capital first letter, no trailing full stop. */
function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return t === "" ? t : `${t[0]?.toUpperCase()}${t.slice(1)}`;
}

/**
 * A log line in plain words with a title where there was an id: "Shipped PRV-14 to main: Move the
 * notes export" becomes "Shipped 'Move the notes export' to main". An id with no known title stays.
 */
export function plainText(text: string, names: TaskNames): string {
  const old = OLD_TASK.exec(text);
  if (old !== null) {
    const [, , what, reason, title = ""] = old;
    if (what === "is running") return `Started ${quote(title)}`;
    if (what?.startsWith("paused"))
      return `Paused ${quote(title)}${reason === "owner" ? "" : ` (${reason})`}`;
    return `${quote(title)} ${what}`;
  }
  const m = WITH_ID.exec(text.replace(/^Start a task /, "Started "));
  if (m === null) return sentence(toYou(text));
  const [, pre = "", id = "", mid = "", tail] = m;
  const known = names.title(id);
  const title = known ?? tail;
  if (title === undefined || title === "") return sentence(toYou(text));
  const rest = known !== undefined && tail !== undefined && tail !== known ? `: ${tail}` : "";
  return sentence(toYou(`${pre}${quote(title)}${mid}${rest}`));
}

/** One line for the page: who did what in plain words, why, and what it is about. */
export interface LogEntry {
  key: string;
  at: string;
  org: string | undefined;
  kind: LogKind;
  tone: Tone;
  sentence: string;
  why?: string | undefined;
  checked?: string | undefined;
  /** The task it is about, to open it. */
  task?: { id: string; item?: string | undefined } | undefined;
  /** Set for the captain's own actions, which Undo works on. */
  action?: CaptainAction | undefined;
}

const OUTCOME_TONE: Record<CaptainAction["outcome"], Tone> = {
  done: "green",
  asked: "amber",
  skipped: "neutral",
  failed: "red",
};

/** A reason that only repeats the line's own words adds nothing. */
function repeats(a: string, b: string): boolean {
  const plain = (t: string) => t.trim().replace(/\.$/, "").toLowerCase();
  return plain(a) === plain(b);
}

/** The entry for a line, or undefined when the log should not show it (a lane chat's status). */
export function describeLine(line: LogLine, names: TaskNames): LogEntry | undefined {
  if (line.source === "captain") {
    const a = line.action;
    return {
      key: line.key,
      at: line.at,
      org: line.org,
      kind: line.kind,
      tone: OUTCOME_TONE[a.outcome],
      sentence: plainText(a.text, names),
      why: sentence(toYou(a.reason)),
      ...(a.evidence === undefined ? {} : { checked: sentence(a.evidence) }),
      ...(a.task === undefined ? {} : { task: { id: a.task } }),
      action: a,
    };
  }
  const e = line.event;
  if (e.task !== undefined && e.kind === "task" && names.isChat(e.task)) return undefined;
  const text = plainText(e.text, names);
  const why = e.reason === undefined || repeats(e.reason, e.text) ? undefined : sentence(toYou(e.reason));
  return {
    key: line.key,
    at: line.at,
    org: line.org,
    kind: line.kind,
    tone: eventTone(e),
    sentence: text,
    why,
    ...(e.task === undefined ? {} : { task: { id: e.task, item: e.item } }),
  };
}

/** Wake-ups are noise on the page: they show in the full log only. */
export function isQuiet(line: LogLine): boolean {
  return line.source === "autonomy" && line.event.kind === "tick";
}
