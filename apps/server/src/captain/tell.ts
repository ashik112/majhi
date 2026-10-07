import { CHAT_BRIEF, isAutonomyChat, isOwnerChat, PRIVATE, type Task } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Store } from "../store/index.ts";
import { reachFromChat } from "../tasks/chat-link.ts";
import type { TaskService } from "../tasks/service.ts";
import { once, tellKey } from "./keys.ts";
import type { Lanes } from "./lanes.ts";
import type { CaptainRepo } from "./repo.ts";

/**
 * `tasks.tell` (SPEC 5.18): the captain writes to a task's lead. Who may, and how often:
 * - the owner may, in any workspace (the UI and the palette);
 * - the captain may, in its lane, for a task of that lane's workspace only;
 * - the captain may, in its root chat (the All chip), for a task of any workspace: the owner is in
 *   that chat, and the admin tool lets it through only when the owner asked;
 * - an agent in its own ordinary chat with the owner may, for a task that chat made or one the owner
 *   named there, in the chat's workspace (`reachFromChat`);
 * - no other agent may, and the captain in any other chat may not.
 * A note is keyed by the lead's last turn (G1): a second note with no new turn of the lead since the
 * last one is not sent and says `already-told`, so two agents cannot talk each other into a loop. The
 * key is stored in the database, so it holds after a restart.
 */

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
  store: Pick<Store, "tasks" | "room">;
  /** The action keys (G1). */
  keys: Pick<CaptainRepo, "claimKey" | "settleKey" | "releaseKey">;
  /** The id of the agent's last finished turn in the task, 0 when it had none: what a note is keyed by. */
  lastTurn: (task: string, agent: string) => number;
  now?: () => Date;
}

/** What a note to a lead did: sent, or why not. Typed: the captain reads `refused`, not prose. */
export type TellResult =
  | { id: string; agent: string; told: true }
  | { id: string; agent: string; told: false; refused: "already-told" | "in-flight" };

export class CaptainTell {
  constructor(private readonly deps: TellDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async tell(
    input: { id: string; agent?: string | undefined; text: string },
    actor: TellActor,
  ): Promise<TellResult> {
    const task = this.deps.store.tasks.get(input.id);
    if (task === undefined) throw new UserError(`There is no task ${input.id}.`, 404);
    if (actor.kind === "owner") {
      const sent = await this.deps.tasks.captainTell({ ...input, task: input.id, by: "owner" });
      return { ...sent, told: true };
    }
    const boss = await this.deps.lanes.boss();
    if (actor.id === undefined || actor.id !== boss) return this.fromChat(task, input, actor);
    const lane = actor.task === undefined ? undefined : this.deps.lanes.orgOf(actor.task);
    const from = actor.task === undefined ? undefined : this.deps.store.tasks.get(actor.task);
    const root = from !== undefined && isRootChat(from, boss);
    if (lane === undefined && !root) {
      throw new UserError(
        "The captain writes to a lead from its workspace lane, or from its root chat (the All chip) only.",
        409,
      );
    }
    if (lane !== undefined && (task.org ?? PRIVATE) !== lane) {
      throw new UserError(
        `Refused: ${task.id} belongs to another workspace, and this lane works in its own only.`,
        409,
      );
    }
    return this.send(task, input, actor.id);
  }

  /** An agent that is not the captain: allowed from its own ordinary chat, for a task that chat is linked to. */
  private async fromChat(
    task: Task,
    input: { id: string; agent?: string | undefined; text: string },
    actor: TellActor,
  ): Promise<TellResult> {
    const from = actor.task === undefined ? undefined : this.deps.store.tasks.get(actor.task);
    if (actor.id === undefined || from === undefined || from.kind !== "chat" || from.brief !== CHAT_BRIEF) {
      throw new UserError(
        "Only the captain, or an agent in its own chat with the owner, writes to a task's lead. Ask the captain, or tell the owner.",
        409,
      );
    }
    const reach = reachFromChat(this.deps.store, { task: from.id, agent: actor.id }, task.id);
    if (!reach.ok) throw new UserError(reach.why, 409);
    return this.send(task, input, actor.id, `@${actor.id}, from the chat "${from.title}"`);
  }

  /** The note to the lead, once per turn of that lead (G1). */
  private async send(
    task: Task,
    input: { id: string; agent?: string | undefined; text: string },
    by: string,
    from?: string,
  ): Promise<TellResult> {
    const agent = input.agent ?? task.team[0];
    const note = { ...input, task: input.id, by, ...(from === undefined ? {} : { from }) };
    // No agent to key by: the send says why it cannot go.
    if (agent === undefined) return { ...(await this.deps.tasks.captainTell(note)), told: true };
    const key = tellKey(task.id, agent, this.deps.lastTurn(task.id, agent));
    const done = await once(this.deps.keys, this.now(), { kind: "tell", key, task: task.id }, () =>
      this.deps.tasks.captainTell(note),
    );
    if (done.done) return { ...done.value, told: true };
    return { id: task.id, agent, told: false, refused: done.why === "repeat" ? "already-told" : "in-flight" };
  }
}

/** True for the captain's root chat: its own chat with the owner, in no workspace, not a lane or the autonomy chat. */
export function isRootChat(task: Pick<Task, "kind" | "brief" | "org" | "team">, boss: string): boolean {
  return isOwnerChat(task) && !isAutonomyChat(task) && task.org === undefined && task.team[0] === boss;
}
