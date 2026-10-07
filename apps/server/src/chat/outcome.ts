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
