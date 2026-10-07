import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

/**
 * A fake of Slack for tests and for trying majhi without Slack: the Web API methods majhi calls, the Socket Mode
 * WebSocket with envelopes that must be acknowledged, channel history, and file downloads behind the bot token.
 * It records what was sent. Nothing here reaches a real server.
 */

export interface FakeChannel {
  id: string;
  name: string;
  /** A direct message or a group of people, instead of a channel. */
  kind?: "channel" | "im" | "mpim";
  /** Whether the app is in it. A channel it is not in answers `not_in_channel`. */
  member?: boolean;
  archived?: boolean;
  /** A private channel: the app cannot join it, it has to be invited. */
  private?: boolean;
}

export interface FakeUser {
  id: string;
  name: string;
  real_name: string;
  team_id?: string;
  is_bot?: boolean;
}

export interface FakeFile {
  id: string;
  name: string;
  mimetype: string;
  data: Uint8Array;
}

export interface StoredMessage {
  channel: string;
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
  files?: FakeFile[];
  edited?: { ts: string };
  deleted?: boolean;
  bot_id?: string;
}

export interface Call {
  method: string;
  token: string;
  params: Record<string, string>;
}

export interface SentMessage {
  channel: string;
  text: string;
  thread_ts?: string;
  ts: string;
}

interface Failure {
  status?: number;
  retryAfter?: number;
  error?: string;
}

export class FakeSlack {
  static readonly BOT_TOKEN = "xoxb-000000000000-fake-token-aaaaaaaaaaaaaaaaaaaa";
  static readonly APP_TOKEN = "xapp-1-A000000-fake-token-aaaaaaaaaaaaaaaaaaaaaaaa";

  readonly team = { id: "T01ACME", name: "Acme" };
  /** The scopes the bot token holds, as `auth.test` lists them in `x-oauth-scopes`. */
  scopes: string[] = [
    "channels:history",
    "groups:history",
    "im:history",
    "mpim:history",
    "channels:read",
    "groups:read",
    "mpim:read",
    "users:read",
    "files:read",
    "channels:join",
    "chat:write",
  ];
  /** While true, answers carry no `x-oauth-scopes`: what the panel sees when Slack does not say what a token holds. */
  hideScopes = false;
  readonly bot = { user: "U0BOT", bot_id: "B0BOT", name: "majhi" };
  readonly users = new Map<string, FakeUser>();
  readonly channels = new Map<string, FakeChannel>();
  readonly messages: StoredMessage[] = [];
  readonly calls: Call[] = [];
  readonly sent: SentMessage[] = [];
  /** Every envelope id the client acknowledged, in order. */
  readonly acks: string[] = [];
  /** Every event delivered over a socket, in order. */
  readonly events: { id: string; event: Record<string, unknown> }[] = [];
  /** How many sockets were opened. */
  opened = 0;
  /** While true, events are stored but not sent: what a gap in the connection looks like. */
  holdEvents = false;

  private server: Server | undefined;
  private sockets: WebSocket[] = [];
  private seq = 0;
  private eventSeq = 0;
  private readonly failures = new Map<string, Failure[]>();
  private port = 0;

  constructor() {
    this.users.set(this.bot.user, {
      id: this.bot.user,
      name: this.bot.name,
      real_name: "majhi",
      team_id: this.team.id,
      is_bot: true,
    });
  }

  /** The Web API address, for `MAJHI_SLACK_API`. */
  get api(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  get socketCount(): number {
    return this.sockets.filter((s) => s.readyState === 1).length;
  }

  // -------------------------------------------------------------------------
  // The world

  addUser(user: FakeUser): FakeUser {
    const made = { team_id: this.team.id, ...user };
    this.users.set(made.id, made);
    return made;
  }

  addChannel(channel: FakeChannel): FakeChannel {
    const made = { kind: "channel" as const, member: true, ...channel };
    this.channels.set(made.id, made);
    return made;
  }

  /** The next ts: always later than the one before. */
  private nextTs(): string {
    this.seq += 1;
    return `${Math.floor(Date.now() / 1000)}.${String(this.seq).padStart(6, "0")}`;
  }

  /** A person writes in a channel (or in a thread of it). Stored always, sent over the socket unless events are held. */
  post(input: {
    channel: string;
    user: string;
    text: string;
    thread?: string;
    files?: FakeFile[];
    subtype?: string;
  }): StoredMessage {
    const stored: StoredMessage = {
      channel: input.channel,
      ts: this.nextTs(),
      user: input.user,
      text: input.text,
      ...(input.thread === undefined ? {} : { thread_ts: input.thread }),
      ...(input.files === undefined ? {} : { files: input.files }),
    };
    this.messages.push(stored);
    this.emit(this.messageEvent(stored, input.subtype));
    return stored;
  }

  /** A person edits a message. */
  edit(channel: string, ts: string, text: string): void {
    const found = this.find(channel, ts);
    if (found === undefined) throw new Error(`No message ${ts}`);
    found.text = text;
    found.edited = { ts: this.nextTs() };
    this.emit({
      type: "message",
      subtype: "message_changed",
      channel,
      channel_type: this.typeOf(channel),
      ts: found.edited.ts,
      message: this.shape(found),
      previous_message: this.shape({ ...found, text: "(before)" }),
    });
  }

  /** A person deletes a message. */
  remove(channel: string, ts: string): void {
    const found = this.find(channel, ts);
    if (found === undefined) throw new Error(`No message ${ts}`);
    found.deleted = true;
    this.emit({
      type: "message",
      subtype: "message_deleted",
      channel,
      channel_type: this.typeOf(channel),
      ts: this.nextTs(),
      deleted_ts: ts,
      previous_message: this.shape(found),
    });
  }

  private find(channel: string, ts: string): StoredMessage | undefined {
    return this.messages.find((m) => m.channel === channel && m.ts === ts);
  }

  private typeOf(channel: string): string {
    const kind = this.channels.get(channel)?.kind ?? "channel";
    return kind === "channel" ? "channel" : kind;
  }

  private shape(m: StoredMessage): Record<string, unknown> {
    return {
      type: "message",
      user: m.user,
      text: m.text,
      ts: m.ts,
      team: this.team.id,
      ...(m.thread_ts === undefined ? {} : { thread_ts: m.thread_ts }),
      ...(m.edited === undefined ? {} : { edited: { user: m.user, ts: m.edited.ts } }),
      ...(m.bot_id === undefined ? {} : { bot_id: m.bot_id }),
      ...(m.files === undefined ? {} : { files: m.files.map((f) => this.fileShape(f)) }),
    };
  }

  private fileShape(f: FakeFile): Record<string, unknown> {
    return {
      id: f.id,
      name: f.name,
      mimetype: f.mimetype,
      size: f.data.byteLength,
      url_private: `http://127.0.0.1:${this.port}/files/${f.id}/${encodeURIComponent(f.name)}`,
    };
  }

  private messageEvent(m: StoredMessage, subtype: string | undefined): Record<string, unknown> {
    return {
      ...this.shape(m),
      ...(subtype === undefined ? {} : { subtype }),
      channel: m.channel,
      channel_type: this.typeOf(m.channel),
      event_ts: m.ts,
      ...(m.files === undefined ? {} : { subtype: "file_share" }),
    };
  }

  // -------------------------------------------------------------------------
  // The socket

  /** Sends an event as an envelope that must be acknowledged. Returns its event id. */
  private emit(event: Record<string, unknown>): string {
    this.eventSeq += 1;
    const id = `Ev${String(this.eventSeq).padStart(6, "0")}`;
    this.events.push({ id, event });
    if (!this.holdEvents) this.sendEnvelope(id, event);
    return id;
  }

  private sendEnvelope(eventId: string, event: Record<string, unknown>): void {
    const live = this.sockets.filter((s) => s.readyState === 1);
    const target = live.at(-1);
    if (target === undefined) return;
    target.send(
      JSON.stringify({
        envelope_id: randomUUID(),
        type: "events_api",
        accepts_response_payload: false,
        payload: {
          token: "legacy",
          team_id: this.team.id,
          api_app_id: "A0MAJHI",
          type: "event_callback",
          event_id: eventId,
          event_time: Math.floor(Date.now() / 1000),
          event,
        },
      }),
    );
  }

  /** Slack sends an event again, as it does when an acknowledgement is late. */
  redeliver(eventId: string): void {
    const found = this.events.find((e) => e.id === eventId);
    if (found === undefined) throw new Error(`No event ${eventId}`);
    this.sendEnvelope(found.id, found.event);
  }

  /** The id of the newest event. */
  lastEvent(): string {
    const last = this.events.at(-1);
    if (last === undefined) throw new Error("No event yet");
    return last.id;
  }

  /** Slack asks the client to reconnect, as it does every hour or so. */
  disconnect(reason: "refresh_requested" | "warning" | "link_disabled" = "refresh_requested"): void {
    for (const s of this.sockets) {
      if (s.readyState === 1)
        s.send(JSON.stringify({ type: "disconnect", reason, debug_info: { host: "fake" } }));
    }
  }

  /** The network drops every socket with no word. */
  drop(): void {
    for (const s of this.sockets) s.terminate();
  }

  /** The next call of this method fails. */
  failNext(method: string, failure: Failure, times = 1): void {
    for (let i = 0; i < times; i++)
      this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  /** Calls of one method. */
  called(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  // -------------------------------------------------------------------------
  // The server

  async listen(port = 0): Promise<this> {
    const server = createServer((req, res) => void this.http(req, res));
    const sockets = new WebSocketServer({ server, path: "/socket" });
    sockets.on("connection", (socket) => {
      this.opened += 1;
      this.sockets.push(socket);
      socket.send(
        JSON.stringify({ type: "hello", num_connections: this.socketCount, debug_info: { host: "fake" } }),
      );
      socket.on("message", (data) => {
        try {
          const parsed: unknown = JSON.parse(data.toString());
          if (typeof parsed === "object" && parsed !== null && "envelope_id" in parsed) {
            this.acks.push(String((parsed as { envelope_id: unknown }).envelope_id));
          }
        } catch {
          // Not an acknowledgement.
        }
      });
      socket.on("close", () => {
        this.sockets = this.sockets.filter((s) => s !== socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    return this;
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) =>
      this.server === undefined ? resolve() : this.server.close(() => resolve()),
    );
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (url.pathname.startsWith("/files/")) {
      const [, , id] = url.pathname.split("/");
      const file = this.messages.flatMap((m) => m.files ?? []).find((f) => f.id === id);
      if (token !== FakeSlack.BOT_TOKEN || file === undefined) {
        // What Slack does without the permission: its sign-in page.
        res.setHeader("content-type", "text/html");
        res.end("<html>Sign in to Slack</html>");
        return;
      }
      res.setHeader("content-type", file.mimetype);
      res.end(Buffer.from(file.data));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const params = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
    const method = url.pathname.replace("/api/", "");
    this.calls.push({ method, token, params });
    const failure = this.failures.get(method)?.shift();
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.end(JSON.stringify(body));
    };
    if (failure !== undefined) {
      if (failure.status === 429)
        return send(
          429,
          { ok: false, error: "ratelimited" },
          { "retry-after": String(failure.retryAfter ?? 1) },
        );
      return send(failure.status ?? 200, { ok: false, error: failure.error ?? "internal_error" });
    }
    const wanted = method === "apps.connections.open" ? FakeSlack.APP_TOKEN : FakeSlack.BOT_TOKEN;
    if (token !== wanted) return send(200, { ok: false, error: "invalid_auth" });
    const needs = SCOPE_OF_METHOD[method];
    if (needs !== undefined && !this.scopes.includes(needs))
      return send(
        200,
        { ok: false, error: "missing_scope", needed: needs, provided: this.scopes.join(",") },
        this.scopeHeader(),
      );
    return send(200, this.answer(method, params), this.scopeHeader());
  }

  private scopeHeader(): Record<string, string> {
    return this.hideScopes ? {} : { "x-oauth-scopes": this.scopes.join(",") };
  }

  private answer(method: string, params: Record<string, string>): Record<string, unknown> {
    const fail = (error: string) => ({ ok: false, error });
    switch (method) {
      case "auth.test":
        return {
          ok: true,
          team_id: this.team.id,
          team: this.team.name,
          user_id: this.bot.user,
          user: this.bot.name,
          bot_id: this.bot.bot_id,
        };
      case "bots.info":
        return { ok: true, bot: { id: this.bot.bot_id, app_id: "A0MAJHI" } };
      case "conversations.list": {
        const wanted = (params.types ?? "public_channel").split(",");
        const pool = [...this.channels.values()].filter(
          (c) =>
            c.kind === "channel" &&
            !(params.exclude_archived === "true" && c.archived === true) &&
            wanted.includes(c.private === true ? "private_channel" : "public_channel"),
        );
        const limit = Number(params.limit ?? "100");
        const start = Number(params.cursor ?? "0");
        const more = start + limit < pool.length;
        return {
          ok: true,
          channels: pool.slice(start, start + limit).map((c) => ({
            id: c.id,
            name: c.name,
            is_private: c.private === true,
            is_member: c.member !== false,
            is_archived: c.archived === true,
          })),
          ...(more ? { response_metadata: { next_cursor: String(start + limit) } } : {}),
        };
      }
      case "conversations.join": {
        const channel = this.channels.get(params.channel ?? "");
        if (channel === undefined) return fail("channel_not_found");
        if (channel.private === true) return fail("method_not_supported_for_channel_type");
        if (channel.archived === true) return fail("is_archived");
        channel.member = true;
        return { ok: true, channel: { id: channel.id, name: channel.name } };
      }
      case "apps.connections.open":
        return { ok: true, url: `ws://127.0.0.1:${this.port}/socket` };
      case "users.info": {
        const user = this.users.get(params.user ?? "");
        if (user === undefined) return fail("user_not_found");
        return {
          ok: true,
          user: {
            id: user.id,
            name: user.name,
            real_name: user.real_name,
            team_id: user.team_id,
            is_bot: user.is_bot === true,
            profile: { display_name: "", real_name: user.real_name },
          },
        };
      }
      case "conversations.info": {
        const channel = this.channels.get(params.channel ?? "");
        if (channel === undefined) return fail("channel_not_found");
        return {
          ok: true,
          channel: {
            id: channel.id,
            name: channel.name,
            is_im: channel.kind === "im",
            is_mpim: channel.kind === "mpim",
            num_members: 4,
          },
        };
      }
      case "conversations.history":
      case "conversations.replies": {
        const channel = this.channels.get(params.channel ?? "");
        if (channel === undefined) return fail("channel_not_found");
        if (channel.member === false) return fail("not_in_channel");
        const oldest = params.oldest ?? "0";
        const live = this.messages.filter((m) => m.channel === channel.id && m.deleted !== true);
        const newer = (m: StoredMessage) => compare(m.ts, oldest) > 0;
        let pool: StoredMessage[];
        if (method === "conversations.history") {
          pool = live.filter((m) => (m.thread_ts === undefined || m.thread_ts === m.ts) && newer(m));
        } else {
          const root = params.ts ?? "";
          pool = live.filter((m) => m.ts === root || (m.thread_ts === root && newer(m)));
        }
        const ordered = pool.toSorted((a, b) => compare(a.ts, b.ts));
        const ascending = method === "conversations.replies";
        const list = ascending ? ordered : ordered.toReversed();
        const limit = Number(params.limit ?? "100");
        const start = Number(params.cursor ?? "0");
        const page = list.slice(start, start + limit);
        const more = start + limit < list.length;
        return {
          ok: true,
          messages: page.map((m) => {
            const replies = live.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts);
            return {
              ...this.shape(m),
              ...(replies.length === 0
                ? {}
                : {
                    thread_ts: m.ts,
                    reply_count: replies.length,
                    latest_reply: replies
                      .map((r) => r.ts)
                      .sort(compare)
                      .at(-1),
                  }),
            };
          }),
          has_more: more,
          ...(more ? { response_metadata: { next_cursor: String(start + limit) } } : {}),
        };
      }
      case "chat.postMessage": {
        const channel = this.channels.get(params.channel ?? "");
        if (channel === undefined) return fail("channel_not_found");
        if (channel.member === false) return fail("not_in_channel");
        if (channel.archived === true) return fail("is_archived");
        const stored: StoredMessage = {
          channel: channel.id,
          ts: this.nextTs(),
          user: this.bot.user,
          bot_id: this.bot.bot_id,
          text: params.text ?? "",
          ...(params.thread_ts === undefined ? {} : { thread_ts: params.thread_ts }),
        };
        this.messages.push(stored);
        this.sent.push({
          channel: channel.id,
          text: stored.text,
          ts: stored.ts,
          ...(params.thread_ts === undefined ? {} : { thread_ts: params.thread_ts }),
        });
        // Slack tells the app of its own messages too.
        this.emit(this.messageEvent(stored, undefined));
        return { ok: true, ts: stored.ts, channel: channel.id };
      }
      default:
        return { ok: true };
    }
  }
}

/** The scope a method needs, as Slack's `missing_scope` names it. */
const SCOPE_OF_METHOD: Record<string, string> = {
  "chat.postMessage": "chat:write",
  "conversations.join": "channels:join",
};

/** Compares two ts strings by their parts, as majhi must. */
function compare(a: string, b: string): number {
  const [as = "0", af = "0"] = a.split(".");
  const [bs = "0", bf = "0"] = b.split(".");
  if (as !== bs) return Number(as) - Number(bs);
  return Number(af) - Number(bf);
}
