import {
  type AuthorityChoice,
  type ChatApp,
  type Draft,
  type Holds,
  PRIVATE,
  type ReplyFlags,
  type ReplyHold,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { OutboundGate, OutboundTransport } from "../playbooks/outbound.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import { ChatSendError } from "./adapter.ts";
import type { ChatHub } from "./hub.ts";
import { railsFor, withoutSecrets } from "./rails.ts";
import type { ClientRooms } from "./rooms.ts";

export interface RepliesDeps {
  store: Store;
  room: Pick<RoomService, "post" | "get">;
  gate: Pick<OutboundGate, "submit" | "edit" | "get">;
  hub: Pick<ChatHub, "send">;
  rooms: ClientRooms;
  /** The Tell row of a workspace as it is now: Ask me whenever Auto-pilot is not On. */
  tell: (org: string) => Promise<AuthorityChoice>;
  /** The Hold list of a workspace, every class filled in. */
  holds: (org: string) => Promise<Holds>;
  /** The names of the workspaces, to keep one workspace's name out of another's replies. */
  orgNames: () => Promise<ReadonlyMap<string, string>>;
  changed: () => void;
  now?: () => Date;
}

export interface ReplyInput {
  room: string;
  text: string;
  /** What the writer says of the text. Absent: the reply waits. */
  flags?: ReplyFlags | undefined;
  /** The id of the person it answers. */
  to?: string | undefined;
  replyTo?: string | undefined;
  thread?: string | undefined;
  /** A report, like an RCA. It always waits. */
  report?: boolean;
}

export type ReplyResult =
  | { state: "sent"; draft: number }
  | { state: "held"; draft: number; why: ReplyHold }
  | { state: "failed"; draft: number; why: string };

type ReplyItem = Extract<RoomItem, { type: "client-reply" }>;

/**
 * Replies to clients. Every one is a draft of the outbound gate, the one place a message leaves majhi. The captain's
 * reply goes through the rails (Tell, the Hold list, the fixed holds) and is sent at once only when they let it;
 * otherwise it waits as a held reply for the owner, who sends, edits or discards it. The owner's own message
 * is sent at once: writing it is the decision.
 */
export class ClientReplies {
  constructor(private readonly deps: RepliesDeps) {}

  private roomOf(id: string): RoomRow {
    const room = this.deps.rooms.room(id);
    if (room.org === undefined) throw new UserError("Link the chat to a workspace first.", 409);
    return room;
  }

  /** Names a reply in this room must not carry: other chats, other workspaces and their people. */
  private async others(room: RoomRow): Promise<string[]> {
    const names = new Set<string>();
    for (const other of this.deps.store.client.rooms()) {
      if (other.id !== room.id) names.add(other.chat.title);
    }
    for (const [org, name] of await this.deps.orgNames()) {
      if (org !== room.org && org !== PRIVATE) names.add(name);
    }
    return [...names].filter((n) => n.trim().length >= 3);
  }

  /** Whether the person was never answered in this room by us. */
  private firstContact(room: string, to: string | undefined): boolean {
    if (to === undefined) return true;
    return !this.deps.store.room
      .page(room, 200)
      .items.some((i) => i.type === "client-reply" && i.state === "sent" && i.to === to);
  }

  /** Messages are missing and nobody has written since: the owner or a teammate, or a reply the owner let out. */
  private afterGap(room: string): boolean {
    for (const item of this.deps.store.room.page(room, 200).items) {
      if (item.type === "client-gap") return true;
      if (item.type === "client" && item.us === true) return false;
      if (item.type === "client-reply" && item.state === "sent" && (item.by === "you" || item.hold !== undefined)) {
        return false;
      }
    }
    return false;
  }

  /** The captain's reply. Sent now when the rails allow it, else held for the owner. */
  async captain(input: ReplyInput): Promise<ReplyResult> {
    const room = this.roomOf(input.room);
    const org = room.org as string;
    if (room.chat.holder !== "captain") {
      throw new UserError("You hold this chat, so the captain does not write in it.", 409);
    }
    const verdict = railsFor({
      tell: await this.deps.tell(org),
      holds: await this.deps.holds(org),
      text: input.text,
      flags: input.flags,
      others: await this.others(room),
      firstContact: this.firstContact(room.id, input.to),
      afterGap: this.afterGap(room.id),
      ...(input.report === true ? { report: true } : {}),
    });
    const { draft } = await this.deps.gate.submit(
      { org, channel: "client", target: room.id, body: verdict.text },
      { kind: "captain", org },
      {
        ...(verdict.send ? { release: "now" as const } : {}),
        prepared: (made) =>
          this.post(room, made, {
            by: "captain",
            to: input.to,
            replyTo: input.replyTo,
            thread: input.thread,
            ...(verdict.send ? {} : { hold: verdict.why }),
          }),
      },
    );
    return this.resultOf(draft, verdict.send ? undefined : verdict.why);
  }

  /** The owner's own message in the chat: sent at once, and the owner holds the chat from then on. */
  async owner(input: { room: string; text: string; replyTo?: string | undefined }): Promise<ReplyResult> {
    const room = this.roomOf(input.room);
    const org = room.org as string;
    const { draft } = await this.deps.gate.submit(
      { org, channel: "client", target: room.id, body: input.text },
      { kind: "owner" },
      {
        release: "now",
        prepared: (made) => this.post(room, made, { by: "you", replyTo: input.replyTo }),
      },
    );
    this.deps.rooms.holder(room.id, "you");
    return this.resultOf(draft, undefined);
  }

  /** The owner changes the words of a reply that waits. */
  edit(draft: number, text: string): Draft {
    const found = this.deps.gate.get(draft);
    if (found === undefined || found.channel !== "client") throw new UserError(`There is no client reply ${draft}.`, 404);
    return this.deps.gate.edit(draft, text);
  }

  private resultOf(draft: Draft, why: ReplyHold | undefined): ReplyResult {
    if (draft.status === "sent") return { state: "sent", draft: draft.id };
    if (draft.status === "failed") return { state: "failed", draft: draft.id, why: draft.result ?? "It did not go." };
    return { state: "held", draft: draft.id, why: why ?? "tell" };
  }

  private stateOf(draft: Draft): ReplyItem["state"] {
    switch (draft.status) {
      case "sent":
        return "sent";
      case "failed":
        return "failed";
      case "discarded":
        return "discarded";
      default:
        return "held";
    }
  }

  private post(
    room: RoomRow,
    draft: Draft,
    more: { by: "captain" | "you"; to?: string | undefined; replyTo?: string | undefined; thread?: string | undefined; hold?: ReplyHold },
  ): void {
    this.deps.room.post(room.id as TaskId, `reply:${draft.id}`, {
      type: "client-reply",
      by: more.by,
      text: draft.body,
      ...(more.to === undefined ? {} : { to: more.to }),
      ...(more.thread === undefined ? {} : { thread: more.thread }),
      ...(more.replyTo === undefined ? {} : { replyTo: more.replyTo }),
      draft: draft.id,
      state: this.stateOf(draft),
      ...(more.hold === undefined ? {} : { hold: more.hold }),
      ...(draft.result === undefined ? {} : { result: draft.result }),
    });
    this.deps.changed();
  }

  /** The same reply with some fields changed. */
  private replace(item: ReplyItem, change: Partial<Pick<ReplyItem, "text" | "state" | "result" | "external">>): void {
    const { id: _id, task, seq: _seq, at: _at, ...payload } = item;
    this.deps.room.post(task as TaskId, item.id, { ...payload, ...change });
    this.deps.changed();
  }

  /** A draft ended or changed: the reply in the room says so. */
  settled(draft: Draft): void {
    if (draft.channel !== "client") return;
    const item = this.deps.room.get(draft.target, `reply:${draft.id}`);
    if (item?.type !== "client-reply") return;
    this.replace(item, {
      text: draft.body,
      state: this.stateOf(draft),
      ...(draft.result === undefined ? {} : { result: draft.result }),
    });
  }

  /** The gate's transport for the client channel: sends the draft to the chat of its room. */
  readonly transport: OutboundTransport = {
    send: async (draft) => {
      const room = this.deps.store.client.room(draft.target);
      if (room === undefined) return { ok: false, detail: "The chat is gone." };
      const item = this.deps.room.get(room.id, `reply:${draft.id}`);
      const reply = item?.type === "client-reply" ? item : undefined;
      try {
        const sent = await this.deps.hub.send(
          room.chat.app as ChatApp,
          room.chat.account,
          {
            chat: room.chat.chat,
            ...(reply?.thread === undefined ? {} : { thread: reply.thread }),
            ...(reply?.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
          },
          withoutSecrets(draft.body),
        );
        if (reply !== undefined) {
          this.replace(reply, {
            external: { app: room.chat.app, account: room.chat.account, chat: room.chat.chat, message: sent.message },
          });
        }
        return { ok: true, detail: `Sent to ${room.chat.title}.` };
      } catch (err) {
        if (err instanceof ChatSendError) return { ok: false, detail: err.message };
        return { ok: false, detail: errorMessage(err) };
      }
    },
  };
}
