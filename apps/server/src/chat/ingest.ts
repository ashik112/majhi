import { createHash } from "node:crypto";
import { relative } from "node:path";
import {
  type ChatEnvelope,
  type ChatFile,
  type ClientRoom,
  externalKeyText,
  type RoomItem,
  type TaskId,
} from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import { type ChatConnection, FILE_CAP_BYTES } from "./adapter.ts";
import type { Contacts } from "./contacts.ts";
import type { ChatHub } from "./hub.ts";
import { withoutSecrets } from "./rails.ts";
import type { ClientRooms } from "./rooms.ts";
import type { ClientTriage } from "./triage.ts";

export interface IngestDeps {
  store: Store;
  room: Pick<RoomService, "postExternal" | "post">;
  rooms: ClientRooms;
  contacts: Contacts;
  hub: Pick<ChatHub, "file">;
  triage: Pick<ClientTriage, "run">;
  majhiHome: string;
  now?: () => Date;
  log?: (line: string) => void;
}

/** A person writing more often than this is stored but no longer read by the captain until they slow down. */
const SENDER_LIMIT = 20;
const SENDER_WINDOW_MS = 10 * 60_000;

type ClientItem = Extract<RoomItem, { type: "client" }>;

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
        ...(env.chat.people === undefined ? {} : { people: env.chat.people }),
      };
      rooms.open(base);
      return;
    }
    let room = rooms.refresh(found, info);
    const org = room.org;
    if (room.chat.ignored === true || org === undefined) return;
    if (room.chat.trouble === "unreachable") room = rooms.patch(room, { trouble: undefined });
    const text = withoutSecrets(env.text);
    const files = await this.files(env);
    const sender = env.sender;
    const contact = sender.verified
      ? this.deps.contacts.ensure(
          org,
          { app: env.external.app, account: env.external.account, native: sender.id },
          sender.name,
        )
      : undefined;
    const us = contact?.contact.us === true;
    const key = externalKeyText(env.external);
    const payload = (): Omit<ClientItem, "id" | "task" | "seq" | "at"> => ({
      type: "client",
      sender,
      ...(us ? { us: true as const } : {}),
      text,
      files,
      external: env.external,
      ...(env.thread === undefined ? {} : { thread: env.thread }),
      ...(env.replyTo === undefined ? {} : { replyTo: env.replyTo }),
      ...(env.forwarded === true ? { forwarded: true as const } : {}),
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
      return { ...rest, text, revisions: [...existing.revisions, { text: existing.text, at: env.at }] };
    });
    if (stored === undefined || !stored.created || stored.item.type !== "client") return;
    const item = stored.item;
    if (us) {
      // The owner or a teammate writes here: the captain stays out of it.
      rooms.holder(room.id, "you");
      return;
    }
    if (contact?.fresh === true) this.deps.contacts.propose(room.id, contact.contact);
    if (!sender.verified || room.chat.holder !== "captain" || this.limited(env)) return;
    const work = this.deps.triage
      .run(room, item)
      .catch((err) => this.deps.log?.(`chat: triage of ${item.id} failed: ${errorMessage(err)}`))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
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
      if (room.chat.app !== conn.app || room.chat.account !== conn.account || room.org === undefined)
        continue;
      this.deps.room.post(room.id as TaskId, `gap:${from}`, { type: "client-gap", from, to });
    }
  }

  /** The bot cannot write to a chat any more. */
  unreachable(conn: ChatConnection, chat: string): void {
    const room = this.deps.rooms.find(conn.app, conn.account, chat);
    if (room !== undefined) this.deps.rooms.patch(room, { trouble: "unreachable" });
  }

  /** The rooms and their account, for a caller that needs them. */
  roomsOf(conn: ChatConnection): RoomRow[] {
    return this.deps.store.client
      .rooms()
      .filter((r) => r.chat.app === conn.app && r.chat.account === conn.account);
  }
}
