import { type Actor, CAPTAIN, type CommandMeta, OWNER } from "@majhi/shared";
import type { Lanes } from "./captain/lanes.ts";

/** Who made a call, as the record keeps it: the captain's agent id is `captain`, not an agent. */
export async function resolveActor(deps: { lanes: Pick<Lanes, "boss"> }, meta: CommandMeta): Promise<Actor> {
  if (meta.actor.kind !== "agent") return OWNER;
  return meta.actor.id === (await deps.lanes.boss()) ? CAPTAIN : { kind: "agent", id: meta.actor.id };
}
