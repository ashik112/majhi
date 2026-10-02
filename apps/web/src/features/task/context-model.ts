import type { ReceiptCompaction, RoomItem } from "@majhi/shared";
import { taskPathOf } from "../room/links";

/** How a context event came about, as the room stores it and the receipt names its `reason`. */
export type ContextReason = ReceiptCompaction["reason"];

/** One compaction or move to a fresh session, newest first in the history. */
export interface ContextEvent {
  at: string;
  agent: string;
  reason: ContextReason;
  before: number | undefined;
  after: number | undefined;
  /** The handoff note, relative to the task folder, when the room still has the event. */
  note: string | undefined;
}

/** What happened, and why, in a few words each. */
export const EVENT_WORDS: Record<ContextReason, { what: string; why: string }> = {
  native: { what: "Compacted", why: "Reached the compact threshold" },
  handoff: {
    what: "Moved to a fresh session",
    why: "Compacting did not bring it under the target, so it wrote a handoff note",
  },
  rotation: { what: "Moved to a fresh session", why: "Reached its turn limit for one session" },
  fresh: { what: "Fresh session", why: "Asked for with Fresh session" },
  recovery: { what: "Moved to a fresh session", why: "The window was full, so majhi wrote the note" },
};

const SAME_EVENT_MS = 15_000;

/**
 * The context history of a task: the receipt's compactions (every one, from the usage log) joined
 * with the room's context lines (recent ones, which hold the handoff note). A room line the receipt
 * does not have yet still shows.
 */
export function contextHistory(
  compactions: readonly ReceiptCompaction[],
  items: readonly RoomItem[],
): ContextEvent[] {
  const lines = items.flatMap((i) => (i.type === "context" ? [i] : []));
  const used = new Set<string>();
  const events: ContextEvent[] = compactions.map((c) => {
    const at = Date.parse(c.at);
    const line = lines.find(
      (l) =>
        !used.has(l.id) &&
        l.agent === c.agent &&
        l.method === c.reason &&
        Math.abs(Date.parse(l.at) - at) <= SAME_EVENT_MS,
    );
    if (line) used.add(line.id);
    return {
      at: c.at,
      agent: c.agent,
      reason: c.reason,
      before: c.before ?? line?.before,
      after: c.after ?? line?.after,
      note: line?.note,
    };
  });
  for (const l of lines) {
    if (used.has(l.id)) continue;
    events.push({
      at: l.at,
      agent: l.agent,
      reason: l.method,
      before: l.before,
      after: l.after,
      note: l.note,
    });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at));
}

/** A file an agent read in its current session, as a path the viewer opens. */
export interface ReadFile {
  /** Relative to the task folder, for `?file=`; undefined when it lies outside it. */
  path: string | undefined;
  /** What to show: the task-relative path, else the path as the agent named it. */
  label: string;
  agent: string;
}

/**
 * Files each agent read since its last compaction or fresh session, newest first, one row per
 * file. Only what the loaded room holds, so a long session can have read more.
 */
export function filesRead(items: readonly RoomItem[], folder: string): ReadFile[] {
  const since = new Map<string, number>();
  for (const i of items) {
    if (i.type === "context") since.set(i.agent, Math.max(since.get(i.agent) ?? 0, i.seq));
  }
  const seen = new Set<string>();
  const out: ReadFile[] = [];
  for (let n = items.length - 1; n >= 0; n--) {
    const i = items[n];
    if (i?.type !== "tool" || i.kind !== "read" || i.status !== "completed") continue;
    if (i.seq <= (since.get(i.agent) ?? 0)) continue;
    for (const location of i.locations) {
      const path = taskPathOf(location, folder);
      const label = path ?? location;
      if (seen.has(label)) continue;
      seen.add(label);
      out.push({ path, label, agent: i.agent });
    }
  }
  return out;
}

/** Messages in the loaded room from the owner and the agents. */
export function roomMessages(items: readonly RoomItem[]): number {
  return items.filter((i) => i.type === "owner" || i.type === "agent").length;
}

export type MeterTone = "calm" | "amber" | "red";

/** Calm well under the threshold, amber in the last tenth before it, red at it. */
export function meterTone(share: number, compactAt: number): MeterTone {
  if (share >= compactAt) return "red";
  return share >= compactAt - 0.1 ? "amber" : "calm";
}
