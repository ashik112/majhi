import { join } from "node:path";
import type { ChatAccount, ChatApp, ChatCursor, ChatEnvelope, ChatFileRef, ChatTrouble } from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import {
  type ChatAdapter,
  type ChatChannelList,
  type ChatConnection,
  type ChatMessage,
  ChatSendError,
  type ChatSink,
  type ChatTarget,
} from "./adapter.ts";

/** A chat app connection as the connections store lists it. */
export interface ChatConnectionInfo {
  id: string;
  org: string;
  app: ChatApp;
  account: string;
}

export interface HubDeps {
  adapters: readonly ChatAdapter[];
  /** The chat app connections that exist now. */
  connections: () => Promise<ChatConnectionInfo[]>;
  /** The tokens of a connection, from secrets.age. They go to the adapter and nowhere else. */
  tokens: (connection: string) => Promise<ChatTokens | undefined>;
  majhiHome: string;
  /** Reads and saves the read position of a connection. */
  cursors: {
    get: (connection: string) => ChatCursor | undefined;
    set: (connection: string, cursor: ChatCursor) => void;
  };
  /** What majhi noted about a connection: permissions an app refused a call for, and that a message event arrived. */
  notes?: {
    get: (connection: string) => ChatNotes;
    set: (connection: string, notes: Partial<ChatNotes>) => void;
  };
  /** Stores one delivery. */
  deliver: (conn: ChatConnection, envelope: ChatEnvelope) => Promise<void>;
  /** Messages were missed between two times: the rooms of the account show it. */
  gap: (conn: ChatConnection, from: string, to: string) => void;
  /** A chat the bot cannot write to any more. */
  unreachable: (conn: ChatConnection, chat: string) => void;
  /** Whether the read loops run at all. Off in previews and tests: only the main server reads chat apps. */
  polling: boolean;
  /** Tells the tabs. */
  changed: () => void;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface ChatNotes {
  /** Permissions an app refused a call for, until a later read of its scopes shows them granted. */
  needed: string[];
  /** A message event has arrived on the connection. */
  eventSeen: boolean;
}

/** What an app signs in with: its bot token, and for Slack the app-level token too. */
export interface ChatTokens {
  token: string;
  appToken?: string | undefined;
  /** Slack: the owner's User OAuth Token, when one is saved. */
  userToken?: string | undefined;
}

interface Running {
  info: ChatConnectionInfo;
  tokens: ChatTokens;
  stop: () => void;
}

/**
 * Starts and stops the read loop of each chat app connection, and is the one way a message leaves for a chat
 * app. Tokens are read here, from secrets.age, when a loop starts or a send is made.
 */
export class ChatHub {
  private readonly running = new Map<string, Running>();
  private readonly troubles = new Map<string, ChatTrouble>();
  private syncing: Promise<void> = Promise.resolve();
  private readonly seen = new Set<string>();

  constructor(private readonly deps: HubDeps) {}

  private adapter(app: ChatApp): ChatAdapter | undefined {
    return this.deps.adapters.find((a) => a.app === app);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Makes the running loops match the connections. Safe to call often: calls queue. */
  sync(): Promise<void> {
    this.syncing = this.syncing
      .then(() => this.syncNow())
      .catch((err) => {
        this.deps.log?.(`chat: sync failed: ${errorMessage(err)}`);
      });
    return this.syncing;
  }

  private async syncNow(): Promise<void> {
    if (!this.deps.polling) return;
    const wanted = new Map((await this.deps.connections()).map((c) => [c.id, c]));
    for (const [id, run] of this.running) {
      const want = wanted.get(id);
      if (want === undefined || want.account !== run.info.account) {
        run.stop();
        this.running.delete(id);
        this.troubles.delete(id);
      }
    }
    for (const info of wanted.values()) {
      const adapter = this.adapter(info.app);
      if (adapter === undefined) continue;
      const tokens = await this.deps.tokens(info.id);
      const had = this.running.get(info.id);
      if (tokens === undefined) {
        had?.stop();
        this.running.delete(info.id);
        this.troubles.set(info.id, "needs-token");
        continue;
      }
      if (
        had !== undefined &&
        had.tokens.token === tokens.token &&
        had.tokens.appToken === tokens.appToken &&
        had.tokens.userToken === tokens.userToken
      )
        continue;
      had?.stop();
      this.start(adapter, info, tokens);
    }
    this.deps.changed();
  }

  private connection(info: ChatConnectionInfo, tokens: ChatTokens): ChatConnection {
    return {
      id: info.id,
      org: info.org,
      app: info.app,
      account: info.account,
      token: tokens.token,
      ...(tokens.appToken === undefined ? {} : { appToken: tokens.appToken }),
      ...(tokens.userToken === undefined ? {} : { userToken: tokens.userToken }),
      filesDir: join(this.deps.majhiHome, "chat-files", info.id),
    };
  }

  private start(adapter: ChatAdapter, info: ChatConnectionInfo, tokens: ChatTokens): void {
    const conn = this.connection(info, tokens);
    const cursor = this.deps.cursors.get(info.id);
    const hours = adapter.capabilities.retentionHours;
    if (cursor !== undefined && hours !== undefined) {
      const missed = this.now().getTime() - Date.parse(cursor.at);
      if (missed > hours * 3_600_000) this.deps.gap(conn, cursor.at, this.now().toISOString());
    }
    const sink: ChatSink = {
      deliver: async (envelope) => {
        await this.deps.deliver(conn, envelope);
        this.sawEvent(info.id);
      },
      save: (next) => this.deps.cursors.set(info.id, next),
      trouble: (trouble) => {
        if (trouble === undefined) this.troubles.delete(info.id);
        else this.troubles.set(info.id, trouble);
        this.deps.changed();
      },
      unreachable: (chat) => this.deps.unreachable(conn, chat),
      gap: (from, to) => this.deps.gap(conn, from, to),
    };
    this.running.set(info.id, { info, tokens, stop: adapter.start(conn, sink, cursor) });
  }

  private sawEvent(connection: string): void {
    const { notes } = this.deps;
    if (notes === undefined || this.seen.has(connection)) return;
    this.seen.add(connection);
    if (!notes.get(connection).eventSeen) notes.set(connection, { eventSeen: true });
  }

  /** A call was refused for want of a permission: it stays on the connection until its scopes show it granted. */
  private noteNeeded(connection: string, err: unknown): void {
    const needed = err instanceof ChatSendError ? err.needed : undefined;
    const { notes } = this.deps;
    if (needed === undefined || notes === undefined) return;
    const had = notes.get(connection).needed;
    if (!had.includes(needed)) {
      notes.set(connection, { needed: [...had, needed] });
      this.deps.changed();
    }
  }

  /** What is noted about a connection. */
  notesOf(connection: string): ChatNotes {
    return this.deps.notes?.get(connection) ?? { needed: [], eventSeen: false };
  }

  /** The accounts and whether each can be read. */
  accounts(known: readonly ChatConnectionInfo[]): ChatAccount[] {
    return known.map((c) => {
      const trouble = this.troubles.get(c.id);
      return {
        connection: c.id,
        org: c.org,
        app: c.app,
        account: c.account,
        ...(trouble === undefined ? {} : { trouble }),
      };
    });
  }

  /** Clears a trouble the owner fixed, and starts the loop again. */
  async restart(connection: string): Promise<void> {
    this.running.get(connection)?.stop();
    this.running.delete(connection);
    this.troubles.delete(connection);
    await this.sync();
  }

  private async resolve(
    app: ChatApp,
    account: string,
  ): Promise<{ adapter: ChatAdapter; conn: ChatConnection }> {
    const adapter = this.adapter(app);
    const info = (await this.deps.connections()).find((c) => c.app === app && c.account === account);
    if (adapter === undefined || info === undefined) {
      throw new Error(`No ${app} account ${account} is connected.`);
    }
    const tokens = await this.deps.tokens(info.id);
    if (tokens === undefined) throw new Error("The bot token is not saved. Set the app up again.");
    return { adapter, conn: this.connection(info, tokens) };
  }

  private async byConnection(
    id: string,
  ): Promise<{ adapter: ChatAdapter; info: ChatConnectionInfo; conn: ChatConnection }> {
    const info = (await this.deps.connections()).find((c) => c.id === id);
    const adapter = info === undefined ? undefined : this.adapter(info.app);
    if (info === undefined || adapter === undefined) throw new Error("That chat connection does not exist.");
    const tokens = await this.deps.tokens(id);
    if (tokens === undefined) throw new Error("The bot token is not saved. Set the app up again.");
    return { adapter, info, conn: this.connection(info, tokens) };
  }

  /** The channels of a connection's workspace. */
  async channels(
    connection: string,
  ): Promise<{ info: ChatConnectionInfo; list: ChatChannelList; notes: ChatNotes }> {
    const { adapter, info, conn } = await this.byConnection(connection);
    if (adapter.channels === undefined) throw new Error(`${info.app} has no channel list.`);
    let list: ChatChannelList;
    try {
      list = await adapter.channels(conn);
    } catch (err) {
      this.noteNeeded(connection, err);
      throw err;
    }
    const scopes = list.scopes;
    const yours = list.you?.state === "ok" ? list.you.scopes : undefined;
    const notes = this.notesOf(connection);
    if (scopes !== undefined) {
      // A permission the token holds now is no longer missing. The owner's own are noted as `user:<scope>`.
      const still = notes.needed.filter((s) =>
        s.startsWith("user:") ? yours === undefined || !yours.includes(s.slice(5)) : !scopes.includes(s),
      );
      if (still.length !== notes.needed.length) this.deps.notes?.set(connection, { needed: still });
    }
    return { info, list, notes: this.notesOf(connection) };
  }

  /** Checks a user token (or the saved one) of a connection against its workspace. Throws a refusal with its fix. */
  async checkYou(connection: string, userToken: string | undefined): Promise<void> {
    const { adapter, conn } = await this.byConnection(connection);
    if (adapter.asYou === undefined) throw new Error("That chat app has no user token.");
    await adapter.asYou({ ...conn, userToken: userToken ?? conn.userToken });
  }

  /** The bot joins a public channel of a connection's workspace. */
  async join(connection: string, channel: string): Promise<void> {
    const { adapter, info, conn } = await this.byConnection(connection);
    if (adapter.join === undefined) throw new Error(`${info.app} bots do not join channels.`);
    try {
      await adapter.join(conn, channel);
    } catch (err) {
      this.noteNeeded(connection, err);
      throw err;
    }
  }

  /** Sends text to a chat of an account. */
  async send(
    app: ChatApp,
    account: string,
    target: ChatTarget,
    message: ChatMessage,
  ): Promise<{ message: string; as?: "you" }> {
    const { adapter, conn } = await this.resolve(app, account);
    try {
      return await adapter.send(conn, target, message);
    } catch (err) {
      this.noteNeeded(conn.id, err);
      if (err instanceof ChatSendError && err.kind === "unreachable")
        this.deps.unreachable(conn, target.chat);
      if (err instanceof ChatSendError && err.kind === "needs-token") {
        this.troubles.set(conn.id, "needs-token");
        this.deps.changed();
      }
      throw err;
    }
  }

  async file(
    app: ChatApp,
    account: string,
    ref: ChatFileRef,
  ): Promise<{ path: string; type: string; bytes: number }> {
    const { adapter, conn } = await this.resolve(app, account);
    return adapter.file(conn, ref);
  }

  capabilities(app: ChatApp): ChatAdapter["capabilities"] | undefined {
    return this.adapter(app)?.capabilities;
  }

  stop(): void {
    for (const run of this.running.values()) run.stop();
    this.running.clear();
  }
}
