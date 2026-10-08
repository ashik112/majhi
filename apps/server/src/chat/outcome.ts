import type { ClientOutcome, RoomItem, TaskId } from "@majhi/shared";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";

type ClientItem = Extract<RoomItem, { type: "client" }>;

/** The one line under a client message: what became of it. Written onto the message itself. */
export function writeOutcome(
  deps: { store: Pick<Store, "room">; room: Pick<RoomService, "post"> },
  room: string,
  item: ClientItem,
  outcome: ClientOutcome,
): void {
  const now = deps.store.room.get(room, item.id);
  const current = now?.type === "client" ? now : item;
  const { id: _id, task: _task, seq: _seq, at: _at, ...payload } = current;
  deps.room.post(room as TaskId, item.id, { ...payload, outcome });
}

/** The messages of a room the captain has not dealt with yet: their outcome still says `working`. */
export function workingItems(store: Pick<Store, "room">, room: string): ClientItem[] {
  return store.room
    .page(room, 100)
    .items.flatMap((i) =>
      i.type === "client" && i.us !== true && i.outcome?.state === "working" ? [i] : [],
    );
}

/**
 * Writes what the captain did onto the message it answers, or onto every message of the room still waiting for it
 * (one reply deals with the whole batch). The finding and the urgent mark stay.
 */
export function markWorking(
  deps: { store: Pick<Store, "room">; room: Pick<RoomService, "post"> },
  room: string,
  outcome: ClientOutcome,
  item?: string,
): ClientItem[] {
  const named = item === undefined ? undefined : deps.store.room.get(room, item);
  const targets: ClientItem[] =
    named === undefined ? workingItems(deps.store, room) : named.type === "client" ? [named] : [];
  for (const target of targets) {
    const now = target.outcome;
    writeOutcome(deps, room, target, {
      ...outcome,
      ...(now?.urgent === true ? { urgent: true as const } : {}),
      ...(now?.finding === undefined ? {} : { finding: now.finding }),
    });
  }
  return targets;
}
