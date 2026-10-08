import {
  type AuthorityChoice,
  type ChatApp,
  type ConnectionConfig,
  effectiveHolds,
  type Holds,
  PRIVATE,
  type ServerEvent,
} from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { CLIENT_MESSAGE_QUESTION, readClientMessage } from "../decisions/uses/client-message.ts";
import type { LayaDecisions } from "../decisions/uses/common.ts";
import { classifyInjection } from "../decisions/uses/injection.ts";
import type { FindingsService } from "../findings/service.ts";
import type { IncidentFacts } from "../incident/facts.ts";
import type { Housekeeper } from "../memory/housekeeper.ts";
import type { OutboundGate } from "../playbooks/outbound.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { ChatAdapter } from "./adapter.ts";
import { CaptainChat } from "./captain.ts";
import { Contacts } from "./contacts.ts";
import { ChatDesk } from "./desk.ts";
import { ClientGate } from "./gate.ts";
import type { ChatHistory } from "./history.ts";
import { type ChatConnectionInfo, ChatHub, type HubDeps } from "./hub.ts";
import { ClientIncidents, type IncidentsDeps } from "./incidents.ts";
import { ChatIngest } from "./ingest.ts";
import { ClientReplies } from "./replies.ts";
import { ClientRooms } from "./rooms.ts";
import { ClientChat, type ClientChatDeps } from "./service.ts";
import { ChatSettings, dayBegins } from "./settings.ts";
import { ChatWaits } from "./waits.ts";
import { ChatWork, type WorkDeps } from "./work.ts";

/** Where each chat app keeps its tokens among the connection's secret entries. */
export const TOKEN_VARIABLES: Partial<
  Record<ChatApp, { token: string; appToken?: string; userToken?: string }>
> = {
  telegram: { token: "TELEGRAM_BOT_TOKEN" },
  slack: { token: "SLACK_BOT_TOKEN", appToken: "SLACK_APP_TOKEN", userToken: "SLACK_USER_TOKEN" },
};

type ClientDeskWake = ConstructorParameters<typeof ChatDesk>[0]["wake"];

export interface ClientChatWiring {
  store: Store;
  room: RoomService;
  gate: Pick<OutboundGate, "submit" | "edit" | "get" | "decide" | "pending">;
  config: ConfigService;
  adapters: readonly ChatAdapter[];
  /** Every connection of every workspace. */
  connectionIds: () => Promise<{ org: string; id: string; connection: ConnectionConfig }[]>;
  secretOf: (connection: string, name: string) => Promise<string | undefined>;
  housekeeper: Pick<Housekeeper, "ask">;
  /** Why a reaction may not act now (Stop everything), or undefined. */
  blocked?: (() => string | undefined) | undefined;
  /** Wakes a workspace's captain lane with one text: a reaction, held only by Stop everything. */
  wake: ClientDeskWake;
  findings: Pick<FindingsService, "report" | "dismiss" | "toTask" | "find" | "ofTask" | "adopt" | "get">;
  /** The ops watch, for the watch incident an incident task is linked to. */
  watch: IncidentsDeps["watch"];
  /** The one reader of an incident's facts, and the engine that opens and joins incidents. */
  facts: IncidentFacts;
  engine: IncidentsDeps["engine"];
  /** Why nobody looked at a workspace's incidents, or undefined. */
  quiet?: IncidentsDeps["quiet"];
  /** A workspace's time zone. */
  tz: IncidentsDeps["tz"];
  /** Moves a done incident task back to an open state through the task lifecycle. */
  reopenIncident: IncidentsDeps["reopen"];
  /** Tells an incident task's lead something, as majhi. */
  askLead: IncidentsDeps["askLead"];
  /** Makes a task for a chat message. */
  createTask: WorkDeps["create"];
  /** Task changes: a task started from a chat tells its client when it is ready. */
  events: { subscribe(listener: (event: ServerEvent) => void): () => void };
  /** Starts a task the captain made for a chat, the way the incident engine starts one: whatever Auto-pilot says. */
  startTask: (task: string) => Promise<void>;
  /** The captain's History, through the autonomy event log. */
  history?: ChatHistory | undefined;
  decisions: LayaDecisions | undefined;
  lane: ClientChatDeps["lane"];
  deleteWebhook: ClientChatDeps["deleteWebhook"];
  saveUserToken: ClientChatDeps["saveUserToken"];
  majhiHome: string;
  /** Whether the read loops run: only the real server's. */
  polling: boolean;
  changed: () => void;
  /** A read loop has a trouble or has none now: the connection's health follows it. */
  troubled?: HubDeps["troubled"];
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ClientChatParts {
  chat: ClientChat;
  hub: ChatHub;
  ingest: ChatIngest;
  rooms: ClientRooms;
  contacts: Contacts;
  replies: ClientReplies;
  gate: ClientGate;
  desk: ChatDesk;
  captain: CaptainChat;
  incidents: ClientIncidents;
  settings: ChatSettings;
  waits: ChatWaits;
  work: ChatWork;
}

/** Builds the client chat parts and joins them. The gate is made first and calls `replies` through the closures given to it. */
export function createClientChat(w: ClientChatWiring): ClientChatParts {
  const rooms = new ClientRooms({
    store: w.store,
    room: w.room,
    majhiHome: w.majhiHome,
    knownOrg: async (org) => org !== PRIVATE && (await w.config.sections()).orgs[org] !== undefined,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  const contacts = new Contacts({
    store: w.store,
    room: w.room,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  const chatConnections = async () => {
    const out: ChatConnectionInfo[] = [];
    for (const c of await w.connectionIds()) {
      if (c.connection.type !== "chat") continue;
      const app = c.connection.fields?.service;
      if (app === undefined || !w.adapters.some((a) => a.app === app)) continue;
      out.push({
        id: c.id,
        org: c.org,
        app: app as ChatApp,
        account: c.connection.fields?.account ?? c.id,
      });
    }
    return out;
  };
  let layaDown = false;
  // Ingest needs the hub (to fetch files) and the hub needs ingest (to deliver): the hub is given closures.
  let ingest: ChatIngest | undefined;
  const hub = new ChatHub({
    adapters: w.adapters,
    connections: chatConnections,
    tokens: async (connection) => {
      const found = (await chatConnections()).find((c) => c.id === connection);
      const names = found === undefined ? undefined : TOKEN_VARIABLES[found.app];
      if (names === undefined) return undefined;
      const token = await w.secretOf(connection, names.token);
      if (token === undefined) return undefined;
      // The owner's own token is optional: without it the bot sends.
      const userToken =
        names.userToken === undefined ? undefined : await w.secretOf(connection, names.userToken);
      const more = userToken === undefined ? {} : { userToken };
      if (names.appToken === undefined) return { token, ...more };
      // A token the app needs and the owner has not saved is a connection that cannot be read.
      const appToken = await w.secretOf(connection, names.appToken);
      return appToken === undefined ? undefined : { token, appToken, ...more };
    },
    majhiHome: w.majhiHome,
    cursors: {
      get: (connection) => w.store.client.cursor(connection),
      set: (connection, cursor) =>
        w.store.client.setCursor(connection, cursor, (w.now?.() ?? new Date()).toISOString()),
    },
    notes: {
      get: (connection) => {
        const cursor = w.store.client.cursor(connection);
        return { needed: cursor?.needed ?? [], eventSeen: cursor?.eventSeen === true };
      },
      set: (connection, notes) =>
        w.store.client.setNotes(connection, notes, (w.now?.() ?? new Date()).toISOString()),
    },
    deliver: async (conn, envelope) => {
      if (ingest === undefined) throw new Error("Chats are not ready.");
      await ingest.deliver(conn, envelope);
    },
    gap: (conn, from, to) => ingest?.gap(conn, from, to),
    unreachable: (conn, chat) => {
      ingest?.unreachable(conn, chat);
      w.changed();
    },
    polling: w.polling,
    changed: w.changed,
    ...(w.troubled === undefined ? {} : { troubled: w.troubled }),
    ...(w.now === undefined ? {} : { now: w.now }),
    ...(w.log === undefined ? {} : { log: w.log }),
  });
  // The line for a reply in a client chat is the chat's own Replies switch (its holder): `captain` is checked before a
  // reply gets here, so the reply sends, still behind the fixed holds. The workspace's Tell row is only the default holder
  // of a newly linked chat. Stop everything holds it: the reply is a draft for the owner.
  const tell = async (_org: string): Promise<AuthorityChoice> =>
    w.blocked?.() === undefined ? "decide" : "ask";
  const holds = async (org: string): Promise<Holds> =>
    effectiveHolds((await w.config.settings()).autonomy.orgs[org]?.holds);
  const replies = new ClientReplies({
    store: w.store,
    room: w.room,
    gate: w.gate,
    hub,
    rooms,
    tell,
    holds,
    dayBegins: async (org) => dayBegins(w.now?.() ?? new Date(), await w.tz(org)),
    orgNames: async () =>
      new Map(
        Object.entries((await w.config.sections()).orgs).map(([id, o]) => [id, o.name] as [string, string]),
      ),
    history: w.history,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  const desk = new ChatDesk({
    store: w.store,
    room: w.room,
    wake: w.wake,
    changed: w.changed,
    ...(w.log === undefined ? {} : { log: w.log }),
  });
  const incidents = new ClientIncidents({
    store: w.store,
    room: w.room,
    replies,
    gate: w.gate,
    findings: w.findings,
    watch: w.watch,
    desk,
    tz: w.tz,
    facts: w.facts,
    engine: w.engine,
    ...(w.quiet === undefined ? {} : { quiet: w.quiet }),
    write: async (org, key, prompt) => {
      try {
        return (await w.housekeeper.ask({ id: key, org }, prompt, (text) => ({ ok: true, value: text })))
          .value;
      } catch {
        return undefined;
      }
    },
    history: w.history,
    reopen: w.reopenIncident,
    askLead: w.askLead,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  const work = new ChatWork({
    store: w.store,
    room: w.room,
    findings: w.findings,
    desk,
    create: w.createTask,
    start: w.startTask,
    history: w.history,
    changed: w.changed,
  });
  const gate = new ClientGate({
    store: w.store,
    room: w.room,
    findings: w.findings,
    desk,
    injects: async (text) => (await classifyInjection(w.decisions, text, "social")).flagged,
    read: async (text) => readClientMessage(w.decisions, text),
    taught: (decision, label) => {
      // The captain's own read of the message is the right answer to Laya's: it labels the decision once.
      w.decisions?.link?.("client-chat", decision, decision, CLIENT_MESSAGE_QUESTION);
      w.decisions?.resolve?.("client-chat", decision, label, "the captain's own read");
    },
    layaAnswered: (answered) => {
      layaDown = !answered;
    },
  });
  const captain = new CaptainChat({
    store: w.store,
    room: w.room,
    incidents,
    work,
    findings: w.findings,
    history: w.history,
    changed: w.changed,
  });
  w.events.subscribe((event) => {
    if (event.type !== "changed" || event.tasks === undefined) return;
    work.changedTasks(event.tasks);
    desk.settle(event.tasks);
  });
  const settings = new ChatSettings({
    store: w.store,
    rooms,
    contacts,
    holds,
    tz: w.tz,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  ingest = new ChatIngest({
    store: w.store,
    room: w.room,
    rooms,
    contacts,
    hub,
    triage: gate,
    triaged: (org, key) => w.findings.find(org, key) !== undefined,
    majhiHome: w.majhiHome,
    ...(w.now === undefined ? {} : { now: w.now }),
    ...(w.log === undefined ? {} : { log: w.log }),
  });
  const chat = new ClientChat({
    store: w.store,
    room: w.room,
    rooms,
    contacts,
    replies,
    ingest,
    hub,
    connections: chatConnections,
    settings,
    captain,
    layaDown: () => layaDown,
    savedHolds: async (org) => (await w.config.settings()).autonomy.orgs[org]?.holds,
    tell,
    lane: w.lane,
    deleteWebhook: w.deleteWebhook,
    saveUserToken: w.saveUserToken,
  });
  const waits = new ChatWaits({
    store: w.store,
    room: w.room,
    findings: w.findings,
    whoIs: (room, card, answer) => chat.whoIs(room, card, answer),
    makeIncident: async (room, item, finding) => {
      const made = await incidents.claim(room, item, finding, { force: true });
      if (made === undefined) throw new Error("The incident could not be opened.");
      return made;
    },
    history: w.history,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  return {
    chat,
    hub,
    ingest,
    rooms,
    contacts,
    replies,
    gate,
    desk,
    captain,
    incidents,
    settings,
    waits,
    work,
  };
}
