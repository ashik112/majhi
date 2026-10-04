import { PRIVATE } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Store } from "../store/index.ts";
import type { TaskService } from "../tasks/service.ts";
import type { Lanes } from "./lanes.ts";

/**
 * `tasks.tell` (SPEC 5.18): the captain writes to a task's lead. Who may, and how often:
 * - the owner may, in any workspace (the UI and the palette);
 * - the captain may, in its lane, for a task of that lane's workspace only;
 * - no other agent may, and the captain outside a lane may not.
 * A task gets at most `TELL_LIMIT` messages in `TELL_WINDOW_MS`, so two agents cannot talk each other
 * into a loop. The limit counts what the captain sent, in memory: a restart gives a fresh window.
 */

export const TELL_LIMIT = 3;
export const TELL_WINDOW_MS = 10 * 60_000;

export interface TellActor {
  kind: "owner" | "agent";
  /** The agent's id, for `agent`. */
  id?: string | undefined;
  /** The task the call comes from. */
  task?: string | undefined;
}

export interface TellDeps {
  tasks: Pick<TaskService, "captainTell">;
  lanes: Pick<Lanes, "boss" | "orgOf">;
  store: Pick<Store, "tasks">;
  now?: () => Date;
}

export class CaptainTell {
  private readonly sent = new Map<string, number[]>();

  constructor(private readonly deps: TellDeps) {}

  private now(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  async tell(
    input: { id: string; agent?: string | undefined; text: string },
    actor: TellActor,
  ): Promise<{ id: string; agent: string }> {
    const task = this.deps.store.tasks.get(input.id);
    if (task === undefined) throw new UserError(`There is no task ${input.id}.`, 404);
    if (actor.kind === "owner") {
      return this.deps.tasks.captainTell({ ...input, task: input.id, by: "owner" });
    }
    const boss = await this.deps.lanes.boss();
    if (actor.id === undefined || actor.id !== boss) {
      throw new UserError(
        "Only the captain writes to a task's lead. Ask the captain, or tell the owner.",
        409,
      );
    }
    const lane = actor.task === undefined ? undefined : this.deps.lanes.orgOf(actor.task);
    if (lane === undefined) {
      throw new UserError("The captain writes to a lead from its workspace lane only.", 409);
    }
    if ((task.org ?? PRIVATE) !== lane) {
      throw new UserError(
        `Refused: ${task.id} belongs to another workspace, and this lane works in its own only.`,
        409,
      );
    }
    const now = this.now();
    const recent = (this.sent.get(task.id) ?? []).filter((at) => now - at < TELL_WINDOW_MS);
    if (recent.length >= TELL_LIMIT) {
      this.sent.set(task.id, recent);
      throw new UserError(
        `Refused: you wrote to ${task.id} ${TELL_LIMIT} times in the last ${TELL_WINDOW_MS / 60_000} minutes. Wait for the lead to answer, or leave it for the owner.`,
        409,
      );
    }
    // Taken before the send, so two calls at once cannot both pass; given back if the send is refused.
    this.sent.set(task.id, [...recent, now]);
    try {
      return await this.deps.tasks.captainTell({ ...input, task: input.id, by: actor.id });
    } catch (err) {
      const kept = [...(this.sent.get(task.id) ?? [])];
      kept.splice(kept.indexOf(now), 1);
      this.sent.set(task.id, kept);
      throw err;
    }
  }
}
