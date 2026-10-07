import {
  type AuthorityChoice,
  type ChatApp,
  type ConnectionConfig,
  effectiveHolds,
  effectiveIncident,
  type Holds,
  PRIVATE,
} from "@majhi/shared";
import { authorityOf, effectiveAuthority } from "../captain/levels.ts";
import type { ConfigService } from "../config/service.ts";
import type { LayaDecisions } from "../decisions/uses/common.ts";
import { classifyInjection } from "../decisions/uses/injection.ts";
import type { FindingsService } from "../findings/service.ts";
import type { Housekeeper } from "../memory/housekeeper.ts";
import type { OutboundGate } from "../playbooks/outbound.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { ChatAdapter } from "./adapter.ts";
import { Contacts } from "./contacts.ts";
import { ChatHub } from "./hub.ts";
import { ClientIncidents, type IncidentsDeps } from "./incidents.ts";
import { ChatIngest } from "./ingest.ts";
import { ClientReplies } from "./replies.ts";
import { ClientRooms } from "./rooms.ts";
import { ClientChat, type ClientChatDeps } from "./service.ts";
import { ClientTriage, type ToolLessModel } from "./triage.ts";

/** Where each chat app keeps its tokens among the connection's secret entries. */
export const TOKEN_VARIABLES: Partial<Record<ChatApp, { token: string; appToken?: string }>> = {
  telegram: { token: "TELEGRAM_BOT_TOKEN" },
  slack: { token: "SLACK_BOT_TOKEN", appToken: "SLACK_APP_TOKEN" },
};

export interface ClientChatWiring {
  store: Store;
  room: RoomService;
  gate: Pick<OutboundGate, "submit" | "edit" | "get">;
  config: ConfigService;
  /** Autonomous mode now: Tell only counts while it is `on`. */
  autonomyMode: () => "off" | "on" | "paused" | "stopping";
  adapters: readonly ChatAdapter[];
  /** Every connection of every workspace. */
  connectionIds: () => Promise<{ org: string; id: string; connection: ConnectionConfig }[]>;
  secretOf: (connection: string, name: string) => Promise<string | undefined>;
  housekeeper: Pick<Housekeeper, "ask">;
  wiki: (org: string, question: string) => Promise<{ answer: string; found: boolean }>;
  rest: (org: string) => Promise<string | undefined>;
  findings: Pick<FindingsService, "report" | "dismiss" | "toTask" | "find" | "ofTask" | "adopt" | "get">;
  /** The ops watch, for the watch incident an incident task is linked to. */
  watch: IncidentsDeps["watch"];
  /** Makes an incident task from a client message: type incident, origin client. */
  createIncident: IncidentsDeps["create"];
  /** A workspace's time zone. */
  tz: IncidentsDeps["tz"];
  /** Moves a done incident task back to an open state through the task lifecycle. */
  reopenIncident: IncidentsDeps["reopen"];
  /** Tells an incident task's lead something, as majhi. */
  askLead: IncidentsDeps["askLead"];
  decisions: LayaDecisions | undefined;
  lane: ClientChatDeps["lane"];
  deleteWebhook: ClientChatDeps["deleteWebhook"];
  majhiHome: string;
  /** Whether the read loops run: only the real server's. */
  polling: boolean;
  changed: () => void;
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
  triage: ClientTriage;
  incidents: ClientIncidents;
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
    const out: { id: string; org: string; app: ChatApp; account: string }[] = [];
    for (const c of await w.connectionIds()) {
      if (c.connection.type !== "chat") continue;
      const app = c.connection.fields?.service;
      if (app === undefined || !w.adapters.some((a) => a.app === app)) continue;
      out.push({ id: c.id, org: c.org, app: app as ChatApp, account: c.connection.fields?.account ?? c.id });
    }
    return out;
  };
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
      if (names.appToken === undefined) return { token };
      // A token the app needs and the owner has not saved is a connection that cannot be read.
      const appToken = await w.secretOf(connection, names.appToken);
      return appToken === undefined ? undefined : { token, appToken };
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
    ...(w.now === undefined ? {} : { now: w.now }),
    ...(w.log === undefined ? {} : { log: w.log }),
  });
  const tell = async (org: string): Promise<AuthorityChoice> => {
    const { autonomy } = await w.config.settings();
    return effectiveAuthority(authorityOf(autonomy, org), w.autonomyMode()).tell;
  };
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
    orgNames: async () =>
      new Map(
        Object.entries((await w.config.sections()).orgs).map(([id, o]) => [id, o.name] as [string, string]),
      ),
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  const model: ToolLessModel = async (org, key, prompt, parse) =>
    (await w.housekeeper.ask({ id: key, org }, prompt, parse)).value;
  const incidents = new ClientIncidents({
    store: w.store,
    room: w.room,
    replies,
    gate: w.gate,
    findings: w.findings,
    watch: w.watch,
    settings: async (org) => effectiveIncident((await w.config.settings()).autonomy.orgs[org]?.incident),
    tz: w.tz,
    create: w.createIncident,
    reopen: w.reopenIncident,
    askLead: w.askLead,
    changed: w.changed,
    ...(w.now === undefined ? {} : { now: w.now }),
  });
  const triage = new ClientTriage({
    store: w.store,
    room: w.room,
    model,
    findings: w.findings,
    replies,
    wiki: w.wiki,
    rest: w.rest,
    incidents: (org, room) => incidents.candidates(org, room),
    incident: incidents,
    injects: async (text) => (await classifyInjection(w.decisions, text, "social")).flagged,
  });
  ingest = new ChatIngest({
    store: w.store,
    room: w.room,
    rooms,
    contacts,
    hub,
    triage,
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
    savedHolds: async (org) => (await w.config.settings()).autonomy.orgs[org]?.holds,
    tell,
    lane: w.lane,
    deleteWebhook: w.deleteWebhook,
  });
  return { chat, hub, ingest, rooms, contacts, replies, triage, incidents };
}
