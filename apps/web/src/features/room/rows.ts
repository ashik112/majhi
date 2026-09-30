import type { RoomItem } from "@majhi/shared";
import { ownerNotice, type Quiet, quietGroup, sameMoment } from "./system-lines";

type SystemItem = Extract<RoomItem, { type: "system" }>;

/** What the log draws: one item, or plain system notes from one moment as a single line. */
export type Row =
  | { kind: "item"; key: string; item: RoomItem }
  | { kind: "notes"; key: string; items: SystemItem[]; quiet: Quiet };

/** How a row sits in the rhythm of the log: messages breathe, activity and notes stack tight. */
export type Beat = "message" | "activity" | "line";

export function beatOf(row: Row): Beat {
  if (row.kind === "notes") return "line";
  switch (row.item.type) {
    case "owner":
      return ownerNotice(row.item) === undefined ? "message" : "line";
    case "agent":
      return "message";
    case "tool":
    case "thought":
    case "plan":
      return "activity";
    case "system":
    case "context":
    case "handoff":
    case "team-plan":
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
    // Warnings and errors keep their own line, in their tone.
    if (item.type === "system" && item.level === "info") {
      if (group.length > 0 && !sameMoment(group, item)) flush();
      group.push(item);
      continue;
    }
    flush();
    rows.push({ kind: "item", key: item.id, item });
  }
  flush();
  return rows;
}
