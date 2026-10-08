import { PRIVATE, type RoomItem, type Task } from "@majhi/shared";
import type { Store } from "../store/index.ts";

/** What the room reads need to know about the captain's lanes (`Lanes` answers it). */
export interface CaptainView {
  /** The lane chats of a workspace, backlog first. */
  lanesOf(org: string): string[];
  /** The workspace whose lane this chat is, or undefined for any other task. */
  orgOfLane(chat: string): string | undefined;
}

function byAtDesc(a: RoomItem, b: RoomItem): number {
  return a.at < b.at ? 1 : a.at > b.at ? -1 : 0;
}

/**
 * The one read of a room that the owner sees (newest first, by time).
 * - A captain lane is the workspace thread: the untagged lines of every lane of the workspace, merged. Lines about a task stay out.
 * - A task is its own room plus the lane lines tagged `about` it, only from the lanes of its own workspace.
 * - Anything else (a chat, the root chat) is its own room.
 * `olderThan` is an `at` bound, exclusive.
 */
export function roomWithCaptain(
  store: Pick<Store, "room">,
  view: CaptainView | undefined,
  task: Pick<Task, "id" | "org" | "kind">,
  limit: number,
  olderThan?: string,
): { items: RoomItem[]; more: boolean } {
  const bounds = olderThan === undefined ? {} : { olderThan };
  if (view === undefined) return store.room.pageAt(task.id, limit, olderThan);
  const laneOrg = view.orgOfLane(task.id);
  if (laneOrg !== undefined) {
    return store.room.mergedPage(view.lanesOf(laneOrg), { untagged: true }, limit, bounds);
  }
  const own = store.room.pageAt(task.id, limit, olderThan);
  if (task.kind === "chat") return own;
  const tagged = store.room.mergedPage(view.lanesOf(task.org ?? PRIVATE), { about: task.id }, limit, bounds);
  // The client messages that opened or joined the task are part of its one timeline.
  const client = store.room.clientLinesOf(task.id, limit, olderThan);
  if (tagged.items.length === 0 && client.items.length === 0) return own;
  const all = [...own.items, ...tagged.items, ...client.items].sort(byAtDesc);
  return { items: all.slice(0, limit), more: own.more || tagged.more || client.more || all.length > limit };
}

/** Where a line written in `task` is shown live: a thread line to every lane of the workspace, a tagged line to its task. */
export function showTargets(
  view: CaptainView | undefined,
  task: string,
  about: string | undefined,
): string[] {
  const org = view?.orgOfLane(task);
  if (view === undefined || org === undefined) return [task];
  if (about !== undefined) return [about];
  return view.lanesOf(org);
}
