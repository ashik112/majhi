import {
  type AuthorityChoice,
  CHAT_APP_LABEL,
  type ChatApp,
  chatRoomSettings,
  type Draft,
  type Holds,
  holdsForRoom,
  mentionedContacts,
  PRIVATE,
  REPLY_HOLD_LABEL,
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
import type { ChatHistory } from "./history.ts";
import { type People, parseBody, renderPlain } from "./format.ts";
import type { ChatHub } from "./hub.ts";
import { railsFor, withoutSecrets } from "./rails.ts";
import type { ClientRooms } from "./rooms.ts";
import { dayBegins } from "./settings.ts";

export interface RepliesDeps {
  store: Store;
  room: Pick<RoomService, "post" | "get">;
  gate: Pick<OutboundGate, "submit" | "edit" | "get" | "decide" | "pending">;
  hub: Pick<ChatHub, "send">;
  rooms: ClientRooms;
  /** The Tell row of a workspace as it is now: Ask me whenever Auto-pilot is not On. */
  tell: (org: string) => Promise<AuthorityChoice>;
  /** The Hold list of a workspace, every class filled in. */
  holds: (org: string) => Promise<Holds>;
  /** The names of the workspaces, to keep one workspace's name out of another's replies. */
  orgNames: () => Promise<ReadonlyMap<string, string>>;
  /** When today began in the workspace's time zone (ISO): the daily reply limit counts from it. Default: UTC midnight. */
  dayBegins?: (org: string) => Promise<string>;
  /** The captain's History: one line for every message it sends or holds for a client. */
  history?: ChatHistory | undefined;
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
  /** What the History says it did, like "Sent an update to Acme Support". Absent: "Replied to <name> in <chat>". */
  note?: string | undefined;
  /** The incident it is about. */
  about?: string | undefined;
}

/** What a reply that waits answers: shown in Needs you so the owner can decide without opening the chat. */
export interface ClientDraftInfo {
  room: string;
  chat: string;
  /** The chat app's name, like Slack. */
  app: string;
  from?: string;
  said?: string;
  /** Why it waits, in plain words. */
  hold?: string;
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
    if (room.chat.archived === true)
      throw new UserError("That chat is unlinked. Its history is read only.", 409);
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
      if (
        item.type === "client-reply" &&
        item.state === "sent" &&
        (item.by === "you" || item.hold !== undefined)
      ) {
        return false;
      }
    }
    return false;
  }

  /** Who a mention names on the chat app of a room: a contact of the room's workspace with an identity there. */
  private people(room: RoomRow): People {
    return (contact) => {
      const view = this.deps.store.client.view(contact);
      if (view === undefined || view.org !== room.org) return undefined;
      const id = view.ids.find((i) => i.app === room.chat.app && i.account === room.chat.account);
      return { name: view.name, native: id?.native, username: id?.username };
    };
  }

  private plain(room: RoomRow, text: string): string {
    return renderPlain(parseBody(text), this.people(room));
  }

  /** The names of the contacts a text mentions, for a reader that sees only the item. */
  private mentionNames(room: RoomRow, text: string): Record<string, string> {
    const people = this.people(room);
    const names: Record<string, string> = {};
    for (const id of mentionedContacts(text)) {
      const person = people(id);
      if (person !== undefined) names[id] = person.name;
    }
    return names;
  }

  /** The captain's reply. Sent now when the rails allow it, else held for the owner. */
  async captain(input: ReplyInput): Promise<ReplyResult> {
    const room = this.roomOf(input.room);
    const org = room.org as string;
    if (room.chat.holder !== "captain") {
      throw new UserError("You hold this chat, so the captain does not write in it.", 409);
    }
    const rails = {
      tell: await this.deps.tell(org),
      // The chat's own Ask-me cases over the workspace's list.
      holds: holdsForRoom(await this.deps.holds(org), room.chat),

      flags: input.flags,
      others: await this.others(room),
      firstContact: this.firstContact(room.id, input.to),
      afterGap: this.afterGap(room.id),
      ...(input.report === true ? { report: true } : {}),
    };
    let verdict = railsFor({ ...rails, text: input.text });
    // The words a client reads are the text without its markup and with the names of whoever is mentioned: the
    // secret scan and the holds read those too.
    const plain = this.plain(room, input.text);
    if (verdict.send && plain !== input.text) {
      const read = railsFor({ ...rails, text: plain });
      if (!read.send) verdict = read.why === "secret" ? read : { ...read, text: input.text };
    }
    // The day's limit: past it, a reply the rails would send waits for the owner. A fixed hold keeps its own reason.
    if (verdict.send && (await this.overLimit(room))) {
      verdict = { send: false, why: "limit", text: verdict.text };
    }
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
    const result = this.resultOf(draft, verdict.send ? undefined : verdict.why);
    this.noteHistory(room, input, result);
    return result;
  }

  /** The History line of what the captain did: sent, held for the owner, or could not send. */
  private noteHistory(room: RoomRow, input: ReplyInput, result: ReplyResult): void {
    const org = room.org as string;
    const who = input.to === undefined ? undefined : this.nameOf(room.id, input.to);
    const did = input.note ?? `Replied to ${who ?? "a client"} in ${room.chat.title}`;
    const text =
      result.state === "sent"
        ? did
        : result.state === "held"
          ? `Held for you: ${lowerFirst(did)} (${REPLY_HOLD_LABEL[result.why]})`
          : `Could not send: ${lowerFirst(did)}`;
    this.deps.history?.({ text, org, task: input.about });
  }

  private nameOf(room: string, sender: string): string | undefined {
    const found = this.deps.store.room
      .page(room, 200)
      .items.find((i) => i.type === "client" && i.sender.id === sender);
    return found?.type === "client" ? found.sender.name : undefined;
  }

  /** Whether the captain sent as many replies in this chat today as the chat's limit allows. */
  private async overLimit(room: RoomRow): Promise<boolean> {
    const limit = chatRoomSettings(room.chat).dailyLimit;
    if (limit === "none") return false;
    const now = this.deps.now?.() ?? new Date();
    const since = (await this.deps.dayBegins?.(room.org as string)) ?? dayBegins(now, "UTC");
    return this.deps.store.client.captainRepliesSince(room.id, since) >= limit;
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

  /**
   * What the rails would hold a report back for that nothing can lift: a secret or another client's name. The owner
   * edits the words until neither is left. Undefined when the text is clean.
   */
  async reportProblem(room: string, text: string): Promise<"secret" | "other-client" | undefined> {
    const row = this.roomOf(room);
    const verdict = railsFor({
      tell: "ask",
      holds: await this.deps.holds(row.org as string),
      text,
      flags: undefined,
      others: await this.others(row),
      firstContact: false,
      afterGap: false,
      report: true,
    });
    if (verdict.send) return undefined;
    return verdict.why === "secret" || verdict.why === "other-client" ? verdict.why : undefined;
  }

  /**
   * A report to a client, after the owner clicked Send: it goes at once and the holder of the chat stays as it is.
   * Only the owner's click reaches this: the captain's own path holds every report.
   */
  async report(input: { room: string; text: string }): Promise<ReplyResult> {
    const room = this.roomOf(input.room);
    const org = room.org as string;
    const { draft } = await this.deps.gate.submit(
      { org, channel: "client", target: room.id, body: input.text },
      { kind: "owner" },
      { release: "now", prepared: (made) => this.post(room, made, { by: "you" }) },
    );
    this.deps.history?.({ text: `Sent the incident report to ${room.chat.title}`, org });
    return this.resultOf(draft, undefined);
  }

  /** The replies of a room that wait for the owner are discarded: the chat is no longer linked. Returns how many. */
  async discardPending(room: string): Promise<number> {
    const waiting = this.deps.gate.pending().filter((d) => d.channel === "client" && d.target === room);
    for (const draft of waiting) await this.deps.gate.decide(draft.id, "discard");
    return waiting.length;
  }

  /** What a waiting reply answers, for the inbox: the chat, who wrote, what they said, and why it waits. */
  describe(draft: Draft): ClientDraftInfo | undefined {
    const room = this.deps.store.client.room(draft.target);
    if (room === undefined) return undefined;
    const reply = this.deps.room.get(room.id, `reply:${draft.id}`);
    const mine = reply?.type === "client-reply" ? reply : undefined;
    const said =
      mine?.replyTo === undefined
        ? undefined
        : this.deps.store.room
            .page(room.id, 200)
            .items.find((i) => i.type === "client" && i.external.message === mine.replyTo);
    const client = said?.type === "client" ? said : undefined;
    return {
      room: room.id,
      chat: room.chat.title,
      app: CHAT_APP_LABEL[room.chat.app],
      ...(client === undefined ? {} : { from: client.sender.name, said: this.plain(room, client.text) }),
      ...(mine?.hold === undefined ? {} : { hold: REPLY_HOLD_LABEL[mine.hold] }),
    };
  }

  /** The owner changes the words of a reply that waits. */
  edit(draft: number, text: string): Draft {
    const found = this.deps.gate.get(draft);
    if (found === undefined || found.channel !== "client")
      throw new UserError(`There is no client reply ${draft}.`, 404);
    return this.deps.gate.edit(draft, text);
  }

  private resultOf(draft: Draft, why: ReplyHold | undefined): ReplyResult {
    if (draft.status === "sent") return { state: "sent", draft: draft.id };
    if (draft.status === "failed")
      return { state: "failed", draft: draft.id, why: draft.result ?? "It did not go." };
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
    more: {
      by: "captain" | "you";
      to?: string | undefined;
      replyTo?: string | undefined;
      thread?: string | undefined;
      hold?: ReplyHold;
    },
  ): void {
    this.deps.room.post(room.id as TaskId, `reply:${draft.id}`, {
      type: "client-reply",
      by: more.by,
      text: draft.body,
      ...this.mentionField(room, draft.body),
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

  private mentionField(room: RoomRow, text: string): { mentions?: Record<string, string> } {
    const names = this.mentionNames(room, text);
    return Object.keys(names).length === 0 ? {} : { mentions: names };
  }

  /** The same reply with some fields changed. */
  private replace(
    item: ReplyItem,
    change: Partial<Pick<ReplyItem, "text" | "state" | "result" | "external" | "as">>,
  ): void {
    const { id: _id, task, seq: _seq, at: _at, mentions: _m, ...payload } = item;
    const room = this.deps.store.client.room(task);
    const names = room === undefined ? undefined : this.mentionField(room, change.text ?? item.text);
    this.deps.room.post(task as TaskId, item.id, { ...payload, ...names, ...change });
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
      if (room.chat.archived === true) return { ok: false, detail: "The chat is unlinked." };
      const item = this.deps.room.get(room.id, `reply:${draft.id}`);
      const reply = item?.type === "client-reply" ? item : undefined;
      try {
        const clean = withoutSecrets(draft.body);
        if (withoutSecrets(this.plain(room, clean)) !== this.plain(room, clean)) {
          return { ok: false, detail: "The words hold a secret." };
        }
        const sent = await this.deps.hub.send(
          room.chat.app as ChatApp,
          room.chat.account,
          {
            chat: room.chat.chat,
            ...(reply?.thread === undefined ? {} : { thread: reply.thread }),
            ...(reply?.replyTo === undefined ? {} : { replyTo: reply.replyTo }),
            ...(room.chat.sendAs === "me" ? { asYou: true } : {}),
          },
          { body: parseBody(clean), people: this.people(room) },
        );
        if (reply !== undefined) {
          this.replace(reply, {
            external: {
              app: room.chat.app,
              account: room.chat.account,
              chat: room.chat.chat,
              message: sent.message,
            },
            ...(sent.as === undefined ? {} : { as: sent.as }),
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

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}
