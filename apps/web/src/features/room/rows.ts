import type { RoomItem } from "@majhi/shared";
import { contextLine } from "./model";
import { ownerNotice, type Quiet, quietGroup, sameMoment } from "./system-lines";

type SystemItem = Extract<RoomItem, { type: "system" }>;

/** What the log draws: one item, or plain system notes from one moment as a single line. */
export type Row =
  | {
      kind: "item";
      key: string;
      item: RoomItem /** Identical lines in a row, drawn once with "x12". */;
      repeat: number;
    }
  | { kind: "notes"; key: string; items: SystemItem[]; quiet: Quiet }
  | { kind: "steps"; key: string; items: RoomItem[]; count: number };

/** How a row sits in the rhythm of the log: messages breathe, activity and notes stack tight. */
export type Beat = "message" | "activity" | "line";

export function beatOf(row: Row): Beat {
  if (row.kind === "notes") return "line";
  if (row.kind === "steps") return "activity";
  switch (row.item.type) {
    case "owner":
      return ownerNotice(row.item) === undefined ? "message" : "line";
    case "agent":
    case "diagram":
    case "client":
    case "client-reply":
      return "message";
    case "tool":
    case "thought":
    case "plan":
      return "activity";
    case "system":
    case "context":
    case "handoff":
    case "team-plan":
    case "client-gap":
    case "same-person":
    case "incident-event":
    case "report":
      return "line";
    case "permission":
    case "approval":
    case "ask":
    case "choice":
    case "secret-request":
    case "review":
    case "paused":
    case "owner-question":
      // A settled card is one quiet row among the tool calls; a pending one stands out as a card.
      return "state" in row.item && row.item.state === "pending" ? "message" : "activity";
  }
}

/** The space above a row, from the beat of the row before it. */
export function gapAbove(before: Beat | undefined, beat: Beat): string {
  if (before === undefined) return "";
  if (before === "activity" && beat === "activity") return "mt-0.5";
  if (before === "line" && beat === "line") return "mt-1";
  if (before !== "message" && beat !== "message") return "mt-2";
  return "mt-4";
}

/** Tool calls, thoughts and settled approvals: what an agent did between its messages. */
function isStep(item: RoomItem): boolean {
  switch (item.type) {
    case "tool":
    case "thought":
      return true;
    case "permission":
    case "approval":
      return item.state !== "pending";
    default:
      return false;
  }
}

/**
 * Folds the steps between messages into one row per run ("12 steps it took"), for rooms read as a
 * conversation. Notes inside a run fold with it. `count` is the tool calls, else the items.
 */
export function foldSteps(rows: readonly Row[]): Row[] {
  const out: Row[] = [];
  let run: RoomItem[] = [];
  const flush = () => {
    const [first] = run;
    if (first === undefined) return;
    const tools = run.filter((i) => i.type === "tool").length;
    out.push({ kind: "steps", key: `steps:${first.id}`, items: run, count: tools > 0 ? tools : run.length });
    run = [];
  };
  for (const row of rows) {
    if (row.kind === "item" && isStep(row.item)) run.push(row.item);
    else if (row.kind === "notes" && run.length > 0) run.push(...row.items);
    else {
      flush();
      out.push(row);
    }
  }
  flush();
  return out;
}

/** The log's rows: plain system notes posted together fold into one line. */
export function rowsOf(items: readonly RoomItem[]): Row[] {
  const rows: Row[] = [];
  let group: SystemItem[] = [];
  const flush = () => {
    const [first] = group;
    if (first === undefined) return;
    rows.push({ kind: "notes", key: first.id, items: group, quiet: quietGroup(group.map((i) => i.text)) });
    group = [];
  };
  for (const item of items) {
    // Facts of an incident and its report are read in the incident card, not in the log.
    if (item.type === "incident-event" || item.type === "report") continue;
    // Warnings and errors keep their own line, in their tone.
    if (item.type === "system" && item.level === "info") {
      if (group.length > 0 && !sameMoment(group, item)) flush();
      group.push(item);
      continue;
    }
    flush();
    const last = rows[rows.length - 1];
    if (last?.kind === "item" && sameLine(last.item, item)) last.repeat += 1;
    else rows.push({ kind: "item", key: item.id, item, repeat: 1 });
  }
  flush();
  return rows;
}

/** The text of a line that says the same thing each time it repeats: a context line, a warning or an error. */
function lineText(item: RoomItem): string | undefined {
  if (item.type === "context") return contextLine(item);
  if (item.type === "system") return `${item.level}:${item.text}`;
  return undefined;
}

/** Two lines in a row with the same text, like the same move to a fresh session posted again and again. */
function sameLine(a: RoomItem, b: RoomItem): boolean {
  const text = lineText(a);
  return text !== undefined && text === lineText(b) && a.type === b.type;
}
