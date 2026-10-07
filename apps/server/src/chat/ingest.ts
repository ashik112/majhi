import { createHash } from "node:crypto";
import { relative } from "node:path";
import {
  type ChatEnvelope,
  type ChatFile,
  type ChatMention,
  type ClientRoom,
  externalKeyText,
  type RoomItem,
  type TaskId,
  tokenizeMentions,
} from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import { type ChatConnection, FILE_CAP_BYTES } from "./adapter.ts";
import { type Contacts, wordsOf } from "./contacts.ts";
import type { ChatHub } from "./hub.ts";
import { writeOutcome } from "./outcome.ts";
import { withoutSecrets } from "./rails.ts";
import type { ClientRooms } from "./rooms.ts";
import type { ClientTriage } from "./triage.ts";

export interface IngestDeps {
  store: Store;
  room: Pick<RoomService, "postExternal" | "post" | "get">;
  rooms: ClientRooms;
  contacts: Contacts;
  hub: Pick<ChatHub, "file">;
  triage: Pick<ClientTriage, "run">;
  /** Whether a message already has its finding: the triage ran for it. */
  triaged?: ((org: string, key: string) => boolean) | undefined;
  majhiHome: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** A person writing more often than this is stored but no longer read by the captain until they slow down. */
const SENDER_LIMIT = 20;
const SENDER_WINDOW_MS = 10 * 60_000;

type ClientItem = Extract<RoomItem, { type: "client" }>;

/** Whether an edit changed what the message asks: more than a word swapped (a typo), or a very short text rewritten. */
export function changedMeaning(before: string, after: string): boolean {
  const had = wordsOf(before);
  const known = new Set(had);
  const added = wordsOf(after).filter((w) => !known.has(w)).length;
  return added >= 2 || (had.length <= 2 && added >= 1);
}

/** The item id of a delivery: the same key is always the same id. */
function itemId(key: string): string {
  return `m:${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
}

/**
 * Takes what an adapter delivers and puts it where it belongs: a room item under its external key (a repeat delivery
 * stores nothing, an edit keeps the earlier text), a contact for the sender, and, for a client's message in a
 * linked chat the captain holds, the captain's triage. Unlinked chats are not read: they get one New chat row.
 */
export class ChatIngest {
  private readonly seen = new Map<string, number[]>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: IngestDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Waits for the triage of messages stored so far. For tests and shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  async deliver(conn: ChatConnection, env: ChatEnvelope): Promise<void> {
    // Other bots and our own echoes never count.
    if (env.sender.bot && env.movedTo === undefined) return;
    const { rooms } = this.deps;
    const info = { title: env.chat.title, people: env.chat.people };
    if (env.movedTo !== undefined) {
      this.relink(conn, env);
      return;
    }
    const found = rooms.find(env.external.app, env.external.account, env.external.chat);
    if (found === undefined) {
      // A direct message from a stranger is ignored. A group or channel gets one New chat row, and nothing is stored.
      if (env.chat.kind === "private") return;
      const base: ClientRoom = {
        app: env.external.app,
        account: env.external.account,
        chat: env.external.chat,
        title: env.chat.title,
        kind: env.chat.kind,
        holder: "captain",
        sendAs: "bot" as const,
        ...(env.chat.people === undefined ? {} : { people: env.chat.people }),
      };
      rooms.open(base);
      return;
    }
    let room = rooms.refresh(found, info);
    const org = room.org;
    if (room.chat.ignored === true || org === undefined) return;
    if (room.chat.trouble === "unreachable") room = rooms.patch(room, { trouble: undefined });
    // Mentions become contact tokens before anything else touches the text: their offsets are the app's.
    const tokenized = tokenizeMentions(env.text, env.mentions ?? [], (m) => this.contactOf(org, env, m));
    const names = tokenized.names;
    const text = withoutSecrets(tokenized.text);
    const files = await this.files(env);
    const sender = env.sender;
    const contact = sender.verified
      ? this.deps.contacts.ensure(
          org,
          {
            app: env.external.app,
            account: env.external.account,
            native: sender.id,
            ...(sender.username === undefined ? {} : { username: sender.username }),
          },
          sender.name,
        )
      : undefined;
    // The owner's own account wrote it: majhi's own post as the owner is already in the room as a reply.
    if (env.owner === true && this.isOurReply(room.id, env.external.message)) return;
    const us = env.owner === true || contact?.contact.us === true;
    if (env.owner === true && contact !== undefined && !contact.contact.us)
      this.deps.contacts.setUs(contact.contact.id, true);
    const key = externalKeyText(env.external);
    const payload = (): Omit<ClientItem, "id" | "task" | "seq" | "at"> => ({
      type: "client",
      sender,
      ...(us ? { us: true as const } : {}),
      text,
      ...(Object.keys(names).length === 0 ? {} : { mentions: names }),
      files,
      external: env.external,
      ...(env.thread === undefined ? {} : { thread: env.thread }),
      ...(env.replyTo === undefined ? {} : { replyTo: env.replyTo }),
      ...(env.forwarded === true ? { forwarded: true as const } : {}),
      ...(env.addressed === true ? { addressed: true as const } : {}),
      revisions: [],
      sentAt: env.at,
    });
    const stored = this.deps.room.postExternal(room.id as TaskId, key, itemId(key), (existing) => {
      if (existing === undefined || existing.type !== "client") {
        // A first delivery. A delete or an edit of a message majhi never saw stores what it has.
        return env.kind === "delete" ? undefined : payload();
      }
      if (env.kind === "new") return undefined;
      if (env.kind === "delete") {
        if (existing.deleted === true) return undefined;
        const { id: _i, task: _t, seq: _s, at: _a, ...rest } = existing;
        return { ...rest, deleted: true };
      }
      if (existing.text === text) return undefined;
      const { id: _i, task: _t, seq: _s, at: _a, ...rest } = existing;
      const { mentions: _m, ...base } = rest;
      return {
        ...base,
        text,
        ...(Object.keys(names).length === 0 ? {} : { mentions: names }),
        revisions: [...existing.revisions, { text: existing.text, at: env.at }],
      };
    });
    if (stored === undefined || stored.item.type !== "client") return;
    const item = stored.item;
    if (!stored.created && !this.worthReading(env, item)) return;
    if (us) {
      // The owner or a teammate writes here: the captain stays out of it.
      if (stored.created) rooms.holder(room.id, "you");
      return;
    }
    if (stored.created && contact?.fresh === true) this.deps.contacts.propose(room.id, contact.contact);
    if (!sender.verified) return;
    if (room.chat.holder !== "captain") {
      if (stored.created) this.skipped(room, item, "You hold this chat");
      return;
    }
    if (this.limited(env)) {
      this.skipped(
        room,
        item,
        `Not read: more than ${SENDER_LIMIT} messages in ${SENDER_WINDOW_MS / 60_000} minutes from ${sender.name}`,
      );
      return;
    }
    if (stored.created && contact !== undefined && this.asksWho(room, item, contact.contact.name)) return;
    if (this.whoWaits(room.id, sender.id)) {
      this.waitsForWho(room, item, sender.name);
      return;
    }
    const work = this.deps.triage
      .run(room, item)
      .catch((err) => this.deps.log?.(`chat: triage of ${item.id} failed: ${errorMessage(err)}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
  }

  private skipped(room: RoomRow, item: ClientItem, why: string): void {
    writeOutcome(this.deps, room.id, item, { state: "skipped", why });
  }

  /**
   * An edit is read again only when it could change what became of the message: one nobody answered or acted on,
   * and words that changed, not a typo fixed.
   */
  private worthReading(env: ChatEnvelope, item: ClientItem): boolean {
    if (env.kind !== "edit" || item.deleted === true) return false;
    const state = item.outcome?.state;
    if (state === "replied" || state === "handled" || state === "working") return false;
    const before = item.revisions.at(-1)?.text ?? "";
    return changedMeaning(before, item.text);
  }

  /** The card that asks whether a sender is one of us, once per person per chat. */
  private whoCard(room: string, sender: string): Extract<RoomItem, { type: "who-is" }> | undefined {
    const found = this.deps.room.get(room, `who:${sender}`);
    return found?.type === "who-is" ? found : undefined;
  }

  private whoWaits(room: string, sender: string): boolean {
    return this.whoCard(room, sender)?.state === "asking";
  }

  private waitsForWho(room: RoomRow, item: ClientItem, name: string): void {
    writeOutcome(this.deps, room.id, item, { state: "waits", why: `Is ${name} one of us?` });
  }

  /**
   * An admin of the workspace or chat that nobody marked may be the owner or a teammate. The chat is asked once,
   * and the message is not read until the answer: a captain's reply to its own owner is the bug it guards against.
   */
  private asksWho(room: RoomRow, item: ClientItem, name: string): boolean {
    if (item.sender.staff !== true || this.whoCard(room.id, item.sender.id) !== undefined) return false;
    this.deps.room.post(room.id as TaskId, `who:${item.sender.id}`, {
      type: "who-is",
      sender: item.sender.id,
      name,
      state: "asking",
    });
    this.waitsForWho(room, item, name);
    return true;
  }

  /** The owner answered who a sender is: their messages that waited are read now (a client) or left alone (one of us). */
  async settleWaiting(roomId: string, sender: string, us: boolean): Promise<void> {
    const room = this.deps.store.client.room(roomId);
    if (room === undefined || room.org === undefined) return;
    for (const item of this.deps.store.room.page(roomId, 100).items.toReversed()) {
      if (item.type !== "client" || item.sender.id !== sender || item.outcome?.state !== "waits") continue;
      if (item.outcome.why?.startsWith("Is ") !== true) continue;
      if (us) {
        this.skipped(room, item, "One of us, not read");
        continue;
      }
      if (room.chat.holder !== "captain") continue;
      await this.deps.triage
        .run(room, item)
        .catch((err) => this.deps.log?.(`chat: triage of ${item.id} failed: ${errorMessage(err)}`));
    }
  }

  /** Whether a message of the chat is one majhi sent (a reply of the room with that message id). */
  private isOurReply(room: string, message: string): boolean {
    return this.deps.store.room
      .page(room, 200)
      .items.some((i) => i.type === "client-reply" && i.external?.message === message);
  }

  /** The contact a mention names: by the app's user id, else by its handle. Someone majhi never saw stays words. */
  private contactOf(
    org: string,
    env: ChatEnvelope,
    mention: ChatMention,
  ): { id: string; name: string } | undefined {
    const { client } = this.deps.store;
    const { app, account } = env.external;
    const found =
      mention.native !== undefined
        ? client.byIdentity(org, { app, account, native: mention.native })
        : mention.username === undefined
          ? undefined
          : client.byUsername(org, app, account, mention.username);
    return found === undefined ? undefined : { id: found.id, name: found.name };
  }

  /** More than SENDER_LIMIT messages from one person in the window: stored, not read. */
  private limited(env: ChatEnvelope): boolean {
    const key = `${externalKeyText({ ...env.external, message: "-" })}:${env.sender.id}`;
    const now = this.now().getTime();
    const times = (this.seen.get(key) ?? []).filter((t) => now - t < SENDER_WINDOW_MS);
    times.push(now);
    this.seen.set(key, times);
    return times.length > SENDER_LIMIT;
  }

  private async files(env: ChatEnvelope): Promise<ChatFile[]> {
    const out: ChatFile[] = [];
    for (const ref of env.files) {
      if (ref.bytes !== undefined && ref.bytes > FILE_CAP_BYTES) {
        out.push({ ...ref, skipped: "Over 20 MB" });
        continue;
      }
      try {
        const got = await this.deps.hub.file(env.external.app, env.external.account, ref);
        out.push({
          ...ref,
          type: got.type,
          bytes: got.bytes,
          path: relative(`${this.deps.majhiHome}/chat-files`, got.path),
        });
      } catch (err) {
        this.deps.log?.(`chat: a file could not be fetched: ${errorMessage(err)}`);
        out.push({ ...ref, skipped: "Could not be fetched" });
      }
    }
    return out;
  }

  /** A group became a supergroup: the room follows the chat to its new id. */
  private relink(conn: ChatConnection, env: ChatEnvelope): void {
    const { rooms, store } = this.deps;
    const old = rooms.find(env.external.app, env.external.account, env.external.chat);
    if (old === undefined || env.movedTo === undefined) return;
    const taken = rooms.find(env.external.app, env.external.account, env.movedTo);
    if (taken !== undefined) {
      // The new chat showed up on its own first: it holds nothing yet, and the old room is the one with history.
      if (store.room.count(taken.id) > 0) return;
      store.tasks.remove(taken.id);
    }
    rooms.patch(old, { chat: env.movedTo });
    this.deps.log?.(`chat: ${conn.id}: ${old.chat.title} moved to a new chat id`);
  }

  /** Messages are missing between two times in every linked chat of an account. */
  gap(conn: ChatConnection, from: string, to: string): void {
    for (const room of this.deps.store.client.rooms()) {
      if (
        room.chat.app !== conn.app ||
        room.chat.account !== conn.account ||
        room.org === undefined ||
        room.chat.archived === true
      )
        continue;
      this.deps.room.post(room.id as TaskId, `gap:${from}`, { type: "client-gap", from, to });
    }
  }

  /** The bot cannot write to a chat any more. */
  unreachable(conn: ChatConnection, chat: string): void {
    const room = this.deps.rooms.find(conn.app, conn.account, chat);
    if (room !== undefined) this.deps.rooms.patch(room, { trouble: "unreachable" });
  }

  /**
   * After a restart: client messages stored in the last day whose triage never ran (majhi stopped between storing
   * them and reading them) are triaged now. A message is stored before the read position moves, so none is lost.
   */
  async recover(): Promise<number> {
    const check = this.deps.triaged;
    if (check === undefined) return 0;
    const since = this.now().getTime() - 24 * 3_600_000;
    let n = 0;
    for (const room of this.deps.store.client.rooms()) {
      if (
        room.org === undefined ||
        room.chat.ignored === true ||
        room.chat.archived === true ||
        room.chat.holder !== "captain"
      )
        continue;
      for (const item of this.deps.store.room.page(room.id, 100).items.toReversed()) {
        if (item.type !== "client" || item.us === true || !item.sender.verified) continue;
        if (Date.parse(item.at) < since || check(room.org, `client:${externalKeyText(item.external)}`))
          continue;
        n += 1;
        await this.deps.triage
          .run(room, item)
          .catch((err) => this.deps.log?.(`chat: triage of ${item.id} failed: ${errorMessage(err)}`));
      }
    }
    return n;
  }

  /** The rooms and their account, for a caller that needs them. */
  roomsOf(conn: ChatConnection): RoomRow[] {
    return this.deps.store.client
      .rooms()
      .filter((r) => r.chat.app === conn.app && r.chat.account === conn.account && r.chat.archived !== true);
  }
}
