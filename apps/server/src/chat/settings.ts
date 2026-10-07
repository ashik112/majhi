import {
  type ChatPerson,
  type ChatSettingsInput,
  type ChatSettingsView,
  chatRoomSettings,
  detectSecrets,
  HOLD_CLASSES,
  type Holds,
  type HoldsPatch,
  type Keep,
  type PersonRole,
  sendAsMeProblem,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import { dayStart, localDay } from "../usage/ranges.ts";
import type { Contacts } from "./contacts.ts";
import type { ClientRooms } from "./rooms.ts";

export interface SettingsDeps {
  store: Store;
  rooms: ClientRooms;
  contacts: Contacts;
  /** The workspace's Ask-me list, every case filled in. */
  holds: (org: string) => Promise<Holds>;
  /** The workspace's time zone. */
  tz: (org: string) => Promise<string>;
  changed: () => void;
  now?: () => Date;
}

/** The first moment of today in the workspace's time zone, ISO. The daily reply limit counts from it. */
export function dayBegins(now: Date, tz: string): string {
  return dayStart(localDay(now, tz), tz).toISOString();
}

/**
 * The per-chat settings of a client room: one sheet for every chat app. They live on the room next to the holder
 * (`ClientRoom`); nothing here is stored anywhere else. Rules are the owner's words and are refused with a secret.
 */
export class ChatSettings {
  constructor(private readonly deps: SettingsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private linked(id: string): RoomRow & { org: string } {
    const room = this.deps.rooms.room(id);
    if (room.org === undefined) throw new UserError("Link the chat to a workspace first.", 409);
    return room as RoomRow & { org: string };
  }

  /** Replies the captain sent in a chat today, in the workspace's time zone. */
  async repliesToday(room: RoomRow & { org: string }): Promise<number> {
    const since = dayBegins(this.now(), await this.deps.tz(room.org));
    return this.deps.store.client.captainRepliesSince(room.id, since);
  }

  private people(room: RoomRow & { org: string }): ChatPerson[] {
    const muted = new Set(room.chat.muted ?? []);
    return this.deps.store.client.senders(room.id).map((s) => {
      const contact = s.verified
        ? this.deps.store.client.byIdentity(room.org, {
            app: room.chat.app,
            account: room.chat.account,
            native: s.id,
          })
        : undefined;
      const role: PersonRole = muted.has(s.id) ? "muted" : contact?.us === true ? "us" : "client";
      return { id: s.id, name: s.name === "" ? "Unknown" : s.name, role, canUs: contact !== undefined };
    });
  }

  async view(id: string): Promise<ChatSettingsView> {
    const room = this.linked(id);
    const settings = chatRoomSettings(room.chat);
    const problem = sendAsMeProblem(room.chat.app, room.chat.kind);
    return {
      room: room.id,
      title: room.chat.title,
      app: room.chat.app,
      kind: room.chat.kind,
      org: room.org,
      holder: room.chat.holder,
      ...settings,
      workspaceHolds: await this.deps.holds(room.org),
      me: { allowed: problem === undefined, ...(problem === undefined ? {} : { why: problem }) },
      repliesToday: await this.repliesToday(room),
      people: this.people(room),
      ...(room.chat.archived === true ? { archived: true as const } : {}),
    };
  }

  async set(input: ChatSettingsInput): Promise<ChatSettingsView> {
    const room = this.linked(input.room);
    if (room.chat.archived === true)
      throw new UserError("That chat is unlinked. Its settings are read only.", 409);
    const change: Partial<RoomRow["chat"]> = {};
    if (input.replyWhen !== undefined) change.replyWhen = input.replyWhen;
    if (input.dailyLimit !== undefined) change.dailyLimit = input.dailyLimit;
    if (input.notify !== undefined) change.notify = input.notify;
    if (input.rules !== undefined) {
      const rules = input.rules.trim();
      if (detectSecrets(rules).length > 0) {
        throw new UserError("The rules hold a secret. Take it out: rules are shown to the captain.", 400);
      }
      change.rules = rules === "" ? undefined : rules;
    }
    if (input.holds !== undefined) {
      const next: HoldsPatch = { ...room.chat.holds };
      for (const kind of HOLD_CLASSES) {
        const value = input.holds[kind];
        if (value === undefined) continue;
        if (value === null) delete next[kind];
        else next[kind] = value;
      }
      change.holds = Object.keys(next).length === 0 ? undefined : next;
    }
    if (input.keep !== undefined) change.keep = input.keep;
    const patched = this.deps.rooms.patch(room, change);
    if (input.keep !== undefined) this.enforce(patched);
    return this.view(room.id);
  }

  /** The owner says what a sender is in this chat. */
  person(id: string, sender: string, role: PersonRole): void {
    const room = this.linked(id);
    const known = this.deps.store.client.senders(room.id).find((s) => s.id === sender);
    if (known === undefined) throw new UserError("Nobody with that id wrote in this chat.", 404);
    const contact = known.verified
      ? this.deps.store.client.byIdentity(room.org, {
          app: room.chat.app,
          account: room.chat.account,
          native: sender,
        })
      : undefined;
    if (role === "us" && contact === undefined) {
      throw new UserError("That sender is not verified, so it cannot be marked as one of us.", 409);
    }
    const muted = (room.chat.muted ?? []).filter((m) => m !== sender);
    if (role === "muted") muted.push(sender);
    this.deps.rooms.patch(room, { muted: muted.length === 0 ? undefined : muted });
    if (contact !== undefined) this.deps.contacts.setUs(contact.id, role === "us");
  }

  /** The messages Keep would remove: older than the newest N, and not pointed to by an incident, task or report. */
  private excess(room: RoomRow, keep: Keep): string[] {
    if (keep === "all") return [];
    const old = this.deps.store.client.messageIds(room.id).slice(keep);
    if (old.length === 0) return [];
    const pointed = this.deps.store.client.pointedItems(room.id);
    return old.filter((i) => !pointed.has(i));
  }

  keepCount(id: string, keep: Keep): number {
    return this.excess(this.linked(id), keep).length;
  }

  /** Deletes what the room's Keep says. Removes from majhi only. */
  enforce(room: RoomRow): number {
    const keep = chatRoomSettings(room.chat).keep;
    const gone = this.excess(room, keep);
    if (gone.length === 0) return 0;
    const n = this.deps.store.client.removeItems(room.id, gone);
    this.deps.changed();
    return n;
  }

  /** The daily pass: every linked chat keeps only what its Keep says. */
  sweep(): number {
    let n = 0;
    for (const room of this.deps.store.client.rooms()) {
      if (room.org === undefined || room.chat.archived === true) continue;
      n += this.enforce(room);
    }
    return n;
  }
}
