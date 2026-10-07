import {
  type AuthorityChoice,
  type ChatApp,
  type ClientList,
  type ClientRow,
  type ContactView,
  effectiveHolds,
  HOLD_CLASSES,
  HOLD_LABEL,
  type HoldsPatch,
  type ProposeRulesInput,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { Contacts } from "./contacts.ts";
import type { ChatConnectionInfo, ChatHub } from "./hub.ts";
import type { ChatIngest } from "./ingest.ts";
import type { ClientReplies } from "./replies.ts";
import type { ClientRooms } from "./rooms.ts";

export interface ClientChatDeps {
  store: Store;
  room: Pick<RoomService, "post" | "get">;
  rooms: ClientRooms;
  contacts: Contacts;
  replies: ClientReplies;
  ingest: ChatIngest;
  hub: ChatHub;
  /** The chat app connections that exist now. */
  connections: () => Promise<ChatConnectionInfo[]>;
  /** The owner's Hold list of a workspace, as saved. */
  savedHolds: (org: string) => Promise<HoldsPatch | undefined>;
  /** The Tell row of a workspace now. */
  tell: (org: string) => Promise<AuthorityChoice>;
  /** Puts a card in a task's room that, when the owner approves it, runs a command as the owner. */
  offer: (card: {
    task: TaskId;
    agent: string;
    command: "autonomy.configure";
    input: Record<string, unknown>;
    summary: string;
    details: unknown;
    reason: string;
  }) => RoomItem;
  /** The captain, and the workspace of a task that is its lane. */
  lane: (task: string) => Promise<{ boss: string; org: string } | undefined>;
  /** Removes Telegram's webhook so majhi may read with getUpdates. */
  deleteWebhook: (connection: string) => Promise<void>;
}

/** What the commands of client chats do. The handlers only check who asks and call these. */
export class ClientChat {
  constructor(private readonly deps: ClientChatDeps) {}

  async list(): Promise<ClientList> {
    const rooms = this.deps.rooms.list();
    return { ...rooms, accounts: this.deps.hub.accounts(await this.deps.connections()) };
  }

  private row(id: string): ClientRow {
    const all = this.deps.rooms.list();
    const found = [...all.clients, ...all.newChats].find((r) => r.id === id);
    if (found === undefined) throw new UserError(`There is no client chat ${id}.`, 404);
    return found;
  }

  async link(room: string, org: string): Promise<ClientRow> {
    // Nothing was stored before the link, so there are no contacts to make yet: they appear as people write.
    const linked = await this.deps.rooms.link(room, org);
    return this.row(linked.id);
  }

  ignore(room: string): void {
    this.deps.rooms.ignore(room);
  }

  holder(room: string, holder: "captain" | "you"): ClientRow {
    this.deps.rooms.holder(room, holder);
    return this.row(room);
  }

  async send(room: string, text: string, replyTo: string | undefined) {
    const out = await this.deps.replies.owner({ room, text, replyTo });
    return { draft: out.draft, state: out.state };
  }

  editReply(draft: number, text: string): void {
    this.deps.replies.edit(draft, text);
  }

  samePerson(room: string, item: string, answer: "same" | "not-same"): void {
    this.deps.contacts.answer(room, item, answer);
  }

  contacts(org: string): ContactView[] {
    return this.deps.contacts.list(org);
  }

  merge(keep: string, merge: string) {
    return this.deps.contacts.merge(keep, merge);
  }

  undoMerge(merge: number): void {
    const record = this.deps.store.client.mergeRecord(merge);
    // The card the merge came from, if any, goes back to what the owner now says: not the same.
    const card = record === undefined ? undefined : this.cardOfMerge(merge);
    this.deps.contacts.undo(merge, card);
  }

  private cardOfMerge(merge: number): string | undefined {
    for (const room of this.deps.store.client.rooms()) {
      const hit = this.deps.store.room
        .page(room.id, 200)
        .items.some((i) => i.type === "same-person" && i.merge === merge);
      if (hit) return room.id;
    }
    return undefined;
  }

  async confirmWebhook(connection: string): Promise<void> {
    await this.deps.deleteWebhook(connection);
    await this.deps.hub.restart(connection);
  }

  /**
   * The captain proposes a change to Tell or to the Hold list. It is a card in the lane's room that runs
   * `autonomy.configure` as the owner when the owner approves it: the captain never applies it.
   */
  async proposeRules(
    input: ProposeRulesInput,
    caller: { agent: string; task: string },
  ): Promise<{ text: string }> {
    const lane = await this.deps.lane(caller.task);
    if (lane === undefined || lane.boss !== caller.agent) {
      throw new UserError("Only the captain proposes this, from its workspace lane.", 409);
    }
    if (lane.org !== input.org) {
      throw new UserError(`Refused: this lane works in its own workspace only, not ${input.org}.`, 409);
    }
    if (input.tell === undefined && input.holds === undefined) {
      throw new UserError("Say what to change: tell, holds, or both.", 400);
    }
    const now = effectiveHolds(await this.deps.savedHolds(input.org));
    const parts: string[] = [];
    if (input.tell !== undefined) {
      parts.push(
        input.tell === "decide" ? "let the captain tell the clients" : "make every reply to the clients wait for you",
      );
    }
    for (const kind of HOLD_CLASSES) {
      const wanted = input.holds?.[kind];
      if (wanted === undefined || wanted === now[kind]) continue;
      parts.push(`${wanted ? "hold" : "stop holding"}: ${HOLD_LABEL[kind].toLowerCase()}`);
    }
    if (parts.length === 0) return { text: "That is how it is set already. Nothing to propose." };
    this.deps.offer({
      task: caller.task as TaskId,
      agent: caller.agent,
      command: "autonomy.configure",
      input: {
        orgs: {
          [input.org]: {
            ...(input.tell === undefined ? {} : { authority: { tell: input.tell } }),
            ...(input.holds === undefined ? {} : { holds: input.holds }),
          },
        },
      },
      summary: parts.join(", "),
      details: { workspace: input.org, tell: input.tell, holds: input.holds },
      reason: input.why,
    });
    return { text: "Waiting for the owner to approve in the room. Only the owner applies it." };
  }

  /** Whether a chat app of a kind exists. */
  hasApp(app: ChatApp): boolean {
    return this.deps.hub.capabilities(app) !== undefined;
  }
}
