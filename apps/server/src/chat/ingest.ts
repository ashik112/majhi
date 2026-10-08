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
import type { ClientGate } from "./gate.ts";
import type { ChatHub } from "./hub.ts";
import { writeOutcome } from "./outcome.ts";
import { withoutSecrets } from "./rails.ts";
import type { ClientRooms } from "./rooms.ts";

export interface IngestDeps {
  store: Store;
  room: Pick<RoomService, "postExternal" | "post" | "get">;
  rooms: ClientRooms;
  contacts: Contacts;
  hub: Pick<ChatHub, "file">;
  triage: Pick<ClientGate, "run">;
  /** Whether a message already has its finding: the triage ran for it. */
  triaged?: ((org: string, key: string) => boolean) | undefined;
  majhiHome: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** A person writing more often than this is stored but no longer read by the captain until they slow down. */
const SENDER_LIMIT = 20;
const SENDER_WINDOW_MS = 10 * 60_000;
/** An unlinked chat keeps this many of its newest messages, to start the room with when it is linked. */
const EARLY_KEEP = 20;

type ClientItem = Extract<RoomItem, { type: "client" }>;

/** How many single-character edits turn one text into the other. Used on short messages only. */
function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * Whether an edit changed what the message asks: two or more new words, or in a very short text a rewrite (a few
 * letters changed is a typo). One word swapped in a longer text is a correction.
 */
export function changedMeaning(before: string, after: string): boolean {
  const had = wordsOf(before);
  const known = new Set(had);
  const added = wordsOf(after).filter((w) => !known.has(w)).length;
  if (added >= 2) return true;
  return added === 1 && had.length <= 2 && distance(before.toLowerCase(), after.toLowerCase()) > 3;
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
      // A direct message from a stranger is ignored. A group or channel gets one New chat row.
      if (env.chat.kind === "private") return;
      const opened = rooms.open({
        app: env.external.app,
        account: env.external.account,
        chat: env.external.chat,
        title: env.chat.title,
        kind: env.chat.kind,
        holder: "captain",
        sendAs: "bot" as const,
        ...(env.chat.people === undefined ? {} : { people: env.chat.people }),
      });
      this.keepEarly(opened, env);
      return;
    }
    let room = rooms.refresh(found, info);
    const org = room.org;
    if (room.chat.ignored === true) return;
    if (org === undefined) {
      this.keepEarly(room, env);
      return;
    }
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

  /**
   * A message of a chat that is not linked yet is kept in the New chat's own room, the newest few, so the New chats row
   * shows what was said and the room starts with it when the chat is linked. Nothing reads it until then.
   */
  private keepEarly(room: RoomRow, env: ChatEnvelope): void {
    if (env.kind === "delete") return;
    const key = externalKeyText(env.external);
    const tokenized = tokenizeMentions(env.text, env.mentions ?? [], () => undefined);
    const stored = this.deps.room.postExternal(room.id as TaskId, key, itemId(key), (existing) => {
      if (existing !== undefined && existing.type !== "client") return undefined;
      return {
        type: "client",
        sender: env.sender,
        text: withoutSecrets(tokenized.text),
        files: [],
        external: env.external,
        ...(env.thread === undefined ? {} : { thread: env.thread }),
        ...(env.replyTo === undefined ? {} : { replyTo: env.replyTo }),
        ...(env.forwarded === true ? { forwarded: true as const } : {}),
        ...(env.addressed === true ? { addressed: true as const } : {}),
        revisions: existing === undefined ? [] : [...existing.revisions, { text: existing.text, at: env.at }],
        sentAt: env.at,
        early: true as const,
      };
    });
    if (stored?.created === true) this.deps.store.room.trim(room.id, EARLY_KEEP);
  }

  /**
   * The chat was just linked: what was said before is in its room. The captain reads the newest message nobody
   * answered, as a client's, and never the older ones, so linking never sends a reply to old news.
   */
  async adoptEarly(roomId: string): Promise<void> {
    const room = this.deps.store.client.room(roomId);
    if (room === undefined || room.org === undefined || room.chat.holder !== "captain") return;
    const early = this.deps.store.room
      .page(roomId, EARLY_KEEP + 5)
      .items.filter(
        (i): i is ClientItem => i.type === "client" && i.early === true && i.outcome === undefined,
      );
    const newest = early.find((i) => i.sender.verified && i.deleted !== true);
    for (const item of early) {
      if (item !== newest) this.skipped(room, item, "From before the chat was linked");
    }
    if (newest === undefined) return;
    const contact = this.deps.contacts.ensure(
      room.org,
      {
        app: room.chat.app,
        account: room.chat.account,
        native: newest.sender.id,
        ...(newest.sender.username === undefined ? {} : { username: newest.sender.username }),
      },
      newest.sender.name,
    );
    if (contact.contact.us === true) {
      this.skipped(room, newest, "One of us, not read");
      return;
    }
    if (contact.fresh) this.deps.contacts.propose(room.id, contact.contact);
    if (this.asksWho(room, newest, contact.contact.name)) return;
    await this.deps.triage
      .run(room, newest)
      .catch((err) => this.deps.log?.(`chat: triage of ${newest.id} failed: ${errorMessage(err)}`));
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
        if (item.early === true && item.outcome !== undefined) continue;
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
