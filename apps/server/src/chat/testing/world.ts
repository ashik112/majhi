import {
  type AuthorityChoice,
  type ChatEnvelope,
  effectiveHolds,
  type Holds,
  type HoldsPatch,
  type ReplyFlags,
  type RoomItem,
} from "@majhi/shared";
import { OutboundGate } from "../../playbooks/outbound.ts";
import { RoomService } from "../../room/service.ts";
import { Store } from "../../store/index.ts";
import type { ChatConnection, ChatMessage } from "../adapter.ts";
import { Contacts } from "../contacts.ts";
import { renderPlain } from "../format.ts";
import { ChatIngest } from "../ingest.ts";
import { ClientReplies } from "../replies.ts";
import { ClientRooms } from "../rooms.ts";

export const CONN: ChatConnection = {
  id: "telegram-acme",
  org: "acme",
  app: "telegram",
  account: "@acme_bot",
  token: "123456:fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  filesDir: "/tmp/majhi-chat-test",
};

export const ORGS = new Map([
  ["acme", "Acme"],
  ["globex", "Globex"],
]);

/** A message of a client in a group, as an adapter delivers it. */
export function envelope(
  over: Partial<ChatEnvelope> & { message?: string; chatId?: string } = {},
): ChatEnvelope {
  const { message, chatId, ...rest } = over;
  return {
    kind: "new",
    external: { app: "telegram", account: CONN.account, chat: chatId ?? "-100", message: message ?? "1" },
    chat: { title: "Acme ops", kind: "group", people: 4 },
    sender: { id: "u1", name: "Sara", bot: false, verified: true },
    text: "Orders page is not loading",
    files: [],
    at: new Date().toISOString(),
    ...rest,
  };
}

export interface WorldOptions {
  tell?: AuthorityChoice;
  holds?: HoldsPatch;
  /** The text a client reply holds, for the rails: sent through the hub. */
  failSend?: boolean;
}

/** Client chats around an in-memory store: real rooms, contacts, gate and replies; a hub that records what it sends. */
export function world(options: WorldOptions = {}) {
  const store = new Store(":memory:");
  const room = new RoomService(store);
  const sent: { chat: string; text: string; thread?: string | undefined; replyTo?: string | undefined }[] =
    [];
  const triaged: RoomItem[] = [];
  const state = {
    tell: options.tell ?? ("ask" as AuthorityChoice),
    holds: effectiveHolds(options.holds) as Holds,
  };
  const rooms = new ClientRooms({
    store,
    room,
    majhiHome: "/tmp/majhi-chat-home",
    knownOrg: async (org) => ORGS.has(org),
    changed: () => undefined,
  });
  const contacts = new Contacts({ store, room, changed: () => undefined });
  const hub = {
    send: async (
      _app: string,
      _account: string,
      target: { chat: string; thread?: string; replyTo?: string },
      message: ChatMessage,
    ) => {
      if (options.failSend === true) throw new Error("Telegram is down");
      const text = renderPlain(message.body, message.people);
      sent.push({ chat: target.chat, text, thread: target.thread, replyTo: target.replyTo });
      return { message: String(500 + sent.length) };
    },
    file: async () => {
      throw new Error("no files in this test");
    },
  };
  let replies: ClientReplies | undefined;
  const gate = new OutboundGate({
    db: store.raw,
    tz: async () => "UTC",
    knownOrg: async (org) => ORGS.has(org),
    transports: {
      client: { send: async (draft) => replies?.transport.send(draft) ?? { ok: false, detail: "not ready" } },
    },
    settled: (draft) => replies?.settled(draft),
  });
  replies = new ClientReplies({
    store,
    room,
    gate,
    hub,
    rooms,
    tell: async () => state.tell,
    holds: async () => state.holds,
    orgNames: async () => ORGS,
    changed: () => undefined,
  });
  const ingest = new ChatIngest({
    store,
    room,
    rooms,
    contacts,
    hub: { file: hub.file },
    triage: {
      run: async (_room, item) => {
        triaged.push(item);
        return undefined;
      },
    },
    majhiHome: "/tmp/majhi-chat-home",
  });
  /** A linked room of Acme for the chat `-100`. */
  async function linked(chat = "-100"): Promise<string> {
    await ingest.deliver(CONN, envelope({ chatId: chat, message: "0", text: "hello" }));
    const found = rooms.find("telegram", CONN.account, chat);
    if (found === undefined) throw new Error("the room was not made");
    await rooms.link(found.id, "acme");
    return found.id;
  }
  const flags = (over: Partial<ReplyFlags> = {}): ReplyFlags => ({
    promisedTime: false,
    money: false,
    security: false,
    severalClients: false,
    ...over,
  });
  return { store, room, rooms, contacts, gate, replies, ingest, sent, triaged, state, linked, flags, hub };
}
