import type { Body, ChatCursor, ChatEnvelope, ChatFileRef, ChatKind } from "@majhi/shared";
import { slackMentions, slackPersonId } from "@majhi/shared";
import WebSocket from "ws";
import { z } from "zod";
import { errorMessage } from "../../errors.ts";
import {
  type ChatAdapter,
  type ChatAsYou,
  type ChatCapabilities,
  type ChatChannelList,
  type ChatConnection,
  type ChatMessage,
  ChatSendError,
  type ChatSink,
  type ChatTarget,
  FILE_CAP_BYTES,
} from "../adapter.ts";
import { saveFetched } from "../files.ts";
import { type People, packBody, renderPlain, renderSlack } from "../format.ts";
import {
  type Fetch,
  SlackApi,
  SlackAuth,
  SlackConversation,
  SlackError,
  SlackMessage,
  SlackMessages,
  SlackNetworkError,
  SlackOpen,
  SlackPosted,
  SlackUser,
} from "./api.ts";
import { checkSlackUser, joinSlackChannel, listSlackChannels } from "./channels.ts";
import { beforeTs, compareTs, laterTs, readSlackText, tsToIso } from "./read.ts";

/** One message of Slack's text holds this much: below the 4,000 Slack recommends, so a long reply splits cleanly. */
export const MAX_TEXT = 3500;

/** Names and channel details are asked once in a while, not on every message. */
const INFO_TTL_MS = 6 * 60 * 60 * 1000;
/** The most tries one call gets when Slack says to wait. */
const CALL_TRIES = 4;
/** How many event ids and message ids are remembered to drop a repeat delivery. */
const SEEN_LIMIT = 4000;
/** Threads written in within this many days are looked at again after a gap. */
const OPEN_THREAD_DAYS = 14;
const OPEN_THREAD_LIMIT = 60;
const HISTORY_PAGE = 200;
/** After a gap, threads that began in this many hours are asked for replies, since the history shows only their root. */
const LOOKBACK_HOURS = 24;
const LOOKBACK_PAGES = 5;
const HELLO_WAIT_MS = 15_000;
const THREAD_KEY = "thread:";

export interface SlackAdapterOptions {
  /** Slack's Web API address; only a test or a trial against a fake Slack points it elsewhere. */
  base?: string | undefined;
  fetch?: Fetch | undefined;
  /** Waits, in ms. Replaced in tests. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

// ---------------------------------------------------------------------------
// What Socket Mode sends

const SocketFrame = z.looseObject({
  type: z.string().optional(),
  envelope_id: z.string().optional(),
  reason: z.string().optional(),
  payload: z.unknown().optional(),
});

const EventCallback = z.object({
  type: z.literal("event_callback"),
  event_id: z.string(),
  team_id: z.string().optional(),
  event: z.unknown(),
});

const MessageEvent = SlackMessage.extend({
  type: z.literal("message"),
  channel: z.string(),
  channel_type: z.string().optional(),
  /** Of an edit: the message as it is now. */
  message: SlackMessage.optional(),
  /** Of a delete: the message that was. */
  previous_message: SlackMessage.optional(),
  deleted_ts: z.string().optional(),
});
type MessageEvent = z.infer<typeof MessageEvent>;

/** Subtypes that are a person writing: everything else (a join, a topic change, a bot's post) is not a client's message. */
const WRITTEN: ReadonlySet<string | undefined> = new Set([
  undefined,
  "thread_broadcast",
  "file_share",
  "me_message",
]);

/** A Slack chat's kind in majhi's three. A channel or a private channel is a group of people. */
function kindOf(channelType: string | undefined, info: { im?: boolean; mpim?: boolean }): ChatKind {
  if (channelType === "im" || info.im === true) return "private";
  return "group";
}

/** One delivery ready to hand over, and what handing it over moves. */
interface Delivery {
  channel: string;
  envelope: ChatEnvelope;
  /** The message's own ts, when storing it moves the channel's read position (a new message, not an edit). */
  advance?: string;
  /** The thread the message belongs to, to look at the thread again after a gap. */
  root?: string;
}

/** One live connection to Slack: the socket, its caches, the read position. Made by `start`, ended by the stop it returns. */
class SlackSession {
  private readonly api: SlackApi;
  private readonly stopper = new AbortController();
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;
  private readonly positions: Record<string, string>;
  private readonly seenEvents = new Set<string>();
  private readonly seenMessages = new Set<string>();
  private readonly users = new Map<
    string,
    { name: string; username?: string | undefined; bot: boolean; at: number }
  >();
  private readonly chats = new Map<string, { title: string; kind: ChatKind; people?: number; at: number }>();
  /** A message's thread, so a reply to a reply goes to the thread's root. */
  private readonly rootOf: Map<string, string>;
  private chain: Promise<unknown> = Promise.resolve();
  private me: { user: string; team: string; bot?: string } | undefined;
  private socket: WebSocket | undefined;
  private refreshing = false;
  private wake: (() => void) | undefined;
  /**
   * Where each channel (and thread) must be read from to fill what the socket did not bring: the position before a
   * gap, or before a message that could not be stored. A channel in here does not move its saved position until it is filled.
   */
  private owed: Record<string, string> = {};
  private gapShown = false;
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly conn: ChatConnection,
    private readonly sink: ChatSink,
    cursor: ChatCursor | undefined,
    private readonly options: SlackAdapterOptions,
    rootOf: Map<string, string>,
    /** The messages majhi sent as the owner (`channel:ts`), so their echoes are not read as the owner typing. */
    private readonly sentAsYou: Set<string>,
    /** Who the owner's user token belongs to, when it is valid. */
    private readonly youOf: () => Promise<{ user: string; team: string } | undefined>,
    /** Resolves when the sends under way to a channel are done: Slack's echo can come before the answer to the post. */
    private readonly sendsDone: (channel: string) => Promise<unknown>,
  ) {
    this.api = new SlackApi({ base: options.base, fetch: options.fetch });
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
    this.positions = { ...(cursor?.position ?? {}) };
    this.rootOf = rootOf;
  }

  private get signal(): AbortSignal {
    return this.stopper.signal;
  }

  private log(line: string): void {
    this.options.log?.(`slack ${this.conn.id}: ${line}`);
  }

  stop(): void {
    this.stopper.abort();
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.socket?.close(1000);
    this.socket = undefined;
  }

  // -------------------------------------------------------------------------
  // Calls that wait out a rate limit

  /** Calls a method, waiting as long as Slack says when it is rate limited, a few times. */
  private async call<T>(
    method: string,
    token: string,
    params: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.api.call(method, token, params, schema, this.signal);
      } catch (err) {
        if (!(err instanceof SlackError) || err.code !== "ratelimited" || attempt >= CALL_TRIES) throw err;
        await this.sleep(((err.retryAfter ?? 1) + 0.25) * 1000, this.signal);
        if (this.signal.aborted) throw err;
      }
    }
  }

  // -------------------------------------------------------------------------
  // The loop

  async run(): Promise<void> {
    let failures = 0;
    // Who the bot is: its own messages are never a client's.
    while (this.me === undefined && !this.signal.aborted) {
      try {
        const auth = await this.call("auth.test", this.conn.token, {}, SlackAuth);
        this.me = {
          user: auth.user_id,
          team: auth.team_id,
          ...(auth.bot_id === undefined ? {} : { bot: auth.bot_id }),
        };
      } catch (err) {
        if (this.refused(err)) return;
        failures += 1;
        this.log(`auth.test failed: ${this.describe(err)}`);
        await this.sleep(this.backoff(failures), this.signal);
      }
    }
    failures = 0;
    while (!this.signal.aborted) {
      try {
        // What was stored before this socket: what the new one cannot tell, the history is asked for.
        const before = { ...this.positions };
        const socket = await this.connect();
        this.socket = socket;
        failures = 0;
        this.sink.trouble(undefined);
        this.owe(before);
        this.enqueue(() => this.catchUp());
        await this.ended();
        if (this.signal.aborted) return;
        this.log("the socket closed; opening another");
        await this.sleep(1000, this.signal);
      } catch (err) {
        if (this.signal.aborted) return;
        if (this.refused(err)) return;
        failures += 1;
        this.log(`the socket failed: ${this.describe(err)}`);
        const wait =
          err instanceof SlackError && err.retryAfter !== undefined
            ? err.retryAfter * 1000
            : this.backoff(failures);
        await this.sleep(wait, this.signal);
      }
    }
  }

  /** The token is refused: nothing will work until the owner saves a new one. */
  private refused(err: unknown): boolean {
    if (err instanceof SlackError && err.badToken) {
      this.sink.trouble("needs-token");
      return true;
    }
    return false;
  }

  private describe(err: unknown): string {
    return err instanceof SlackError || err instanceof SlackNetworkError ? err.message : errorMessage(err);
  }

  private backoff(failures: number): number {
    return Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
  }

  /** Resolves when no socket is current: Slack closed it, or the network dropped it. */
  private ended(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket === undefined) resolve();
      else this.wake = resolve;
    });
  }

  /** Opens a socket with the app-level token and resolves once Slack says hello on it. */
  private async connect(): Promise<WebSocket> {
    const appToken = this.conn.appToken;
    if (appToken === undefined) {
      this.sink.trouble("needs-token");
      throw new SlackError("invalid_app_token");
    }
    const { url } = await this.call("apps.connections.open", appToken, {}, SlackOpen);
    const socket = new WebSocket(url, { handshakeTimeout: HELLO_WAIT_MS });
    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        this.signal.removeEventListener("abort", onAbort);
      };
      const fail = (message: string) => {
        settle();
        socket.terminate();
        reject(new SlackNetworkError(message));
      };
      const onAbort = () => fail("Stopped.");
      const timer = setTimeout(() => fail("Slack did not say hello on the socket."), HELLO_WAIT_MS);
      this.signal.addEventListener("abort", onAbort, { once: true });
      // The same handler serves the socket for its whole life, so no event after hello falls between two handlers.
      socket.on("message", (data) => {
        const hello = this.frame(socket, data.toString());
        if (hello) {
          settle();
          resolve();
        }
      });
      socket.on("error", (err) => {
        this.log(`socket error: ${errorMessage(err)}`);
        fail(`The socket could not open: ${errorMessage(err)}`);
      });
      socket.on("close", () => {
        fail("The socket closed.");
        if (this.socket === socket) {
          this.socket = undefined;
          this.wake?.();
        }
      });
    });
    return socket;
  }

  /** Handles one frame. Returns true for Slack's hello. */
  private frame(socket: WebSocket, text: string): boolean {
    const parsed = SocketFrame.safeParse(parseJson(text));
    if (!parsed.success) return false;
    const frame = parsed.data;
    // Slack wants each envelope answered at once, before anything is done with it.
    if (frame.envelope_id !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ envelope_id: frame.envelope_id }));
    }
    if (frame.type === "hello") return true;
    if (frame.type === "disconnect") {
      // Slack is about to close this socket: open the next one first, so no event falls between the two.
      if (frame.reason === "refresh_requested" || frame.reason === "warning") void this.refresh(socket);
      return false;
    }
    if (frame.type !== "events_api" || frame.envelope_id === undefined) return false;
    const callback = EventCallback.safeParse(frame.payload);
    if (callback.success) this.enqueue(() => this.handle(callback.data));
    return false;
  }

  /** Opens a new socket, makes it the current one, and only then closes the old one. */
  private async refresh(old: WebSocket): Promise<void> {
    if (this.refreshing || this.socket !== old) return;
    this.refreshing = true;
    try {
      const next = await this.connect();
      this.socket = next;
      old.close(1000);
    } catch (err) {
      // The old socket stays until Slack closes it; the loop then opens another.
      this.log(`the refresh failed: ${this.describe(err)}`);
    } finally {
      this.refreshing = false;
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch((err) => this.log(`an event failed: ${this.describe(err)}`));
  }

  // -------------------------------------------------------------------------
  // One event

  private seen(set: Set<string>, key: string): boolean {
    return set.has(key);
  }

  private remember(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > SEEN_LIMIT) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  }

  private rememberRoot(message: string, root: string): void {
    this.rootOf.set(message, root);
    if (this.rootOf.size > SEEN_LIMIT) {
      const oldest = this.rootOf.keys().next().value;
      if (oldest !== undefined) this.rootOf.delete(oldest);
    }
  }

  private async handle(payload: z.infer<typeof EventCallback>): Promise<void> {
    if (this.seen(this.seenEvents, payload.event_id)) return;
    const event = MessageEvent.safeParse(payload.event);
    if (event.success) {
      const delivery = await this.build(event.data);
      if (delivery !== undefined) await this.deliver(delivery, true);
    }
    this.remember(this.seenEvents, payload.event_id);
  }

  /** The delivery a message event makes, or undefined when it is not a client's message: a bot's post, our own, a join. */
  private async build(event: MessageEvent): Promise<Delivery | undefined> {
    if (event.subtype === "message_changed") {
      const message = event.message;
      if (message === undefined) return undefined;
      return this.fromMessage(event.channel, message, event.channel_type, "edit");
    }
    if (event.subtype === "message_deleted") {
      const before = event.previous_message;
      if (event.deleted_ts === undefined) return undefined;
      if (before !== undefined && this.ours(before)) return undefined;
      if (before?.user !== undefined && (await this.sentByUs(event.channel, before))) return undefined;
      const ts = event.deleted_ts;
      const channel = await this.chat(event.channel, event.channel_type, before?.user);
      return {
        channel: event.channel,
        envelope: {
          kind: "delete",
          external: this.key(event.channel, ts),
          chat: channel,
          sender: {
            id: before?.user === undefined ? "slack" : slackPersonId(before.user), name: "", bot: false, verified: before?.user !== undefined },
          text: "",
          files: [],
          at: this.now().toISOString(),
        },
      };
    }
    if (!WRITTEN.has(event.subtype)) return undefined;
    return this.fromMessage(event.channel, event, event.channel_type, "new");
  }

  private ours(message: SlackMessage): boolean {
    return (
      message.bot_id !== undefined || message.subtype === "bot_message" || message.user === this.me?.user
    );
  }

  /** The owner's own post that majhi sent as the owner: majhi's reply, already stored as one. */
  private async sentByUs(channel: string, message: SlackMessage): Promise<boolean> {
    if (message.user === undefined || (await this.youOf())?.user !== message.user) return false;
    await this.sendsDone(channel).catch(() => undefined);
    return this.sentAsYou.has(`${channel}:${message.ts}`);
  }

  private key(channel: string, ts: string) {
    return { app: "slack" as const, account: this.conn.account, chat: channel, message: ts };
  }

  /** A message of a person as the envelope majhi stores; undefined when nobody wrote it (ours, a bot's, empty). */
  private async fromMessage(
    channel: string,
    message: SlackMessage,
    channelType: string | undefined,
    kind: "new" | "edit",
  ): Promise<Delivery | undefined> {
    if (this.ours(message) || message.user === undefined) return undefined;
    if (await this.sentByUs(channel, message)) return undefined;
    const owner = await this.youOf();
    const byOwner = owner !== undefined && message.user === owner.user;
    const files: ChatFileRef[] = [];
    for (const file of message.files ?? []) {
      if (file.url_private === undefined) continue;
      files.push({
        id: file.url_private,
        name: file.name ?? file.title ?? "file",
        ...(file.mimetype === undefined ? {} : { type: file.mimetype }),
        ...(file.size === undefined ? {} : { bytes: file.size }),
      });
    }
    if (message.text === "" && files.length === 0) return undefined;
    const sender = await this.person(message.user);
    // The names of the people the text mentions, asked once each, so an unknown mention still reads as a name.
    const named = new Map<string, string>();
    for (const mention of slackMentions(message.text)) {
      const id = mention.native;
      if (id === undefined || named.has(id)) continue;
      const found = await this.person(id);
      named.set(id, found.name);
    }
    const read = readSlackText(message.text, (id) => named.get(id));
    const info = await this.chat(channel, channelType, message.user, sender.name);
    const root =
      message.thread_ts !== undefined && message.thread_ts !== message.ts ? message.thread_ts : undefined;
    if (root !== undefined) this.rememberRoot(`${channel}:${message.ts}`, root);
    const at = kind === "edit" ? tsToIso(message.edited?.ts ?? message.ts) : tsToIso(message.ts);
    return {
      channel,
      envelope: {
        kind,
        external: this.key(channel, message.ts),
        chat: info,
        sender: {
          id: slackPersonId(message.user),
          name: sender.name,
          ...(sender.username === undefined ? {} : { username: sender.username }),
          bot: sender.bot,
          verified: true,
        },
        text: read.text,
        files,
        at,
        ...(root === undefined ? {} : { thread: root, replyTo: root }),
        ...(read.mentions.length === 0 ? {} : { mentions: read.mentions }),
        ...(byOwner ? { owner: true as const } : {}),
        ...(read.mentions.some(
          (m) =>
            (this.me !== undefined && m.native === slackPersonId(this.me.user)) ||
            (owner !== undefined && m.native === slackPersonId(owner.user)),
        )
          ? { addressed: true }
          : {}),
      },
      ...(kind === "new" ? { advance: message.ts } : {}),
      ...(root === undefined ? {} : { root }),
    };
  }

  /** Hands one delivery over; the channel's read position moves only when it was stored. */
  private async deliver(d: Delivery, save: boolean): Promise<boolean> {
    const messageKey = `${d.channel}:${d.envelope.external.message}`;
    if (d.envelope.kind === "new" && this.seen(this.seenMessages, messageKey)) return true;
    try {
      await this.sink.deliver(d.envelope);
    } catch (err) {
      this.log(`a message could not be stored: ${this.describe(err)}`);
      // Slack was answered already and will not send it again: it is read from the history, from just before it.
      this.owe({ [d.channel]: this.positions[d.channel] ?? beforeTs(d.envelope.external.message) });
      this.later(5000);
      return false;
    }
    if (d.envelope.kind === "new") this.remember(this.seenMessages, messageKey);
    if (d.advance !== undefined && this.owed[d.channel] === undefined) {
      this.positions[d.channel] = laterTs(this.positions[d.channel], d.advance);
      if (d.root !== undefined) {
        const key = `${THREAD_KEY}${d.channel}:${d.root}`;
        this.positions[key] = laterTs(this.positions[key], d.advance);
      }
      if (save) this.save();
    }
    return true;
  }

  private save(): void {
    this.prune();
    this.sink.save({ position: { ...this.positions }, at: this.now().toISOString() });
  }

  /** Threads quiet for two weeks, and all but the busiest recent ones, are no longer looked at after a gap. */
  private prune(): void {
    const floor = String(Math.floor(this.now().getTime() / 1000) - OPEN_THREAD_DAYS * 86_400);
    const threads = Object.entries(this.positions)
      .filter(([key]) => key.startsWith(THREAD_KEY))
      .sort((a, b) => compareTs(b[1], a[1]));
    threads.forEach(([key, ts], i) => {
      if (i >= OPEN_THREAD_LIMIT || compareTs(ts, floor) < 0) delete this.positions[key];
    });
  }

  /** Notes that these must be read from the history, each from the earlier of what is owed and what is given. */
  private owe(from: Record<string, string>): void {
    for (const [key, ts] of Object.entries(from)) {
      const had = this.owed[key];
      if (had === undefined || compareTs(ts, had) < 0) this.owed[key] = ts;
    }
  }

  // -------------------------------------------------------------------------
  // Who and where

  private async person(id: string) {
    const cached = this.users.get(id);
    if (cached !== undefined && this.now().getTime() - cached.at < INFO_TTL_MS) return cached;
    try {
      const { user } = await this.call("users.info", this.conn.token, { user: id }, SlackUser);
      const name = [user.profile?.display_name, user.real_name, user.profile?.real_name, user.name].find(
        (n): n is string => n !== undefined && n !== "",
      );
      const out = {
        name: name ?? id,
        ...(user.name === undefined ? {} : { username: user.name }),
        bot: user.is_bot === true,
        at: this.now().getTime(),
      };
      this.users.set(id, out);
      return out;
    } catch (err) {
      if (this.refused(err)) throw err;
      // A name is a nicety: the user id still says who it is.
      return cached ?? { name: id, bot: false, at: 0 };
    }
  }

  private async chat(
    channel: string,
    channelType: string | undefined,
    user: string | undefined,
    userName?: string,
  ): Promise<{ title: string; kind: ChatKind; people?: number }> {
    const cached = this.chats.get(channel);
    if (cached !== undefined && this.now().getTime() - cached.at < INFO_TTL_MS) return cached;
    try {
      const { channel: info } = await this.call(
        "conversations.info",
        this.conn.token,
        { channel },
        SlackConversation,
      );
      const kind = kindOf(channelType, { im: info.is_im === true, mpim: info.is_mpim === true });
      const title =
        kind === "private"
          ? (userName ?? (user === undefined ? channel : (await this.person(user)).name))
          : info.name === undefined
            ? channel
            : info.is_mpim === true
              ? info.name
              : `#${info.name}`;
      const out = {
        title,
        kind,
        ...(info.num_members === undefined ? {} : { people: info.num_members }),
        at: this.now().getTime(),
      };
      this.chats.set(channel, out);
      return out;
    } catch (err) {
      if (this.refused(err)) throw err;
      return cached ?? { title: userName ?? channel, kind: kindOf(channelType, {}) };
    }
  }

  // -------------------------------------------------------------------------
  // Catch-up after a gap

  /** Runs again in a while: a delivery failed or Slack was rate limiting the catch-up. */
  private later(ms: number): void {
    if (this.retry !== undefined || this.signal.aborted) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.enqueue(() => this.catchUp());
    }, ms);
    this.retry.unref?.();
  }

  /**
   * Fetches what was written since each owed position (and in each thread written in lately), in order. It stores
   * through the same path as live events and the same keys, so a message seen both ways is stored once. A channel
   * Slack would not give all of is left owed and tried again, and the rooms are told messages may be missing.
   */
  private async catchUp(): Promise<void> {
    const channels = Object.keys(this.owed).filter((k) => !k.startsWith(THREAD_KEY));
    if (channels.length === 0) return;
    const to = this.now().toISOString();
    const from = this.sinceOwed();
    for (const channel of channels) {
      const oldest = this.owed[channel];
      if (oldest === undefined) continue;
      // Cleared first, so what is stored now moves the position; a failure inside owes it again.
      const threads = Object.keys(this.owed).filter((t) => t.startsWith(`${THREAD_KEY}${channel}:`));
      const stillOwed = { ...this.owed };
      delete this.owed[channel];
      for (const key of threads) delete this.owed[key];
      try {
        await this.history(channel, oldest);
        for (const key of threads) {
          const root = key.slice(`${THREAD_KEY}${channel}:`.length);
          await this.replies(channel, root, stillOwed[key] ?? oldest);
        }
      } catch (err) {
        if (this.refused(err)) return;
        if (err instanceof SlackError && err.unreachable) {
          this.sink.unreachable(channel);
          continue;
        }
        this.owe({ [channel]: oldest });
        this.log(`the catch-up of ${channel} stopped: ${this.describe(err)}`);
      }
    }
    this.save();
    if (Object.keys(this.owed).length === 0) {
      this.gapShown = false;
      return;
    }
    if (!this.gapShown) {
      this.gapShown = true;
      this.sink.gap?.(from, to);
    }
    this.later(60_000);
  }

  private sinceOwed(): string {
    let oldest: string | undefined;
    for (const [key, ts] of Object.entries(this.owed)) {
      if (!key.startsWith(THREAD_KEY) && (oldest === undefined || compareTs(ts, oldest) < 0)) oldest = ts;
    }
    return oldest === undefined ? this.now().toISOString() : tsToIso(oldest);
  }

  /**
   * The channel's messages after `oldest`, and the replies since then to the threads of the last day: a reply to an
   * older message is not in the history, but its root shows `latest_reply`. Messages older than `oldest` are never stored.
   */
  private async history(channel: string, oldest: string): Promise<void> {
    const found: SlackMessage[] = [];
    const lookback = `${Math.floor(this.now().getTime() / 1000) - LOOKBACK_HOURS * 3600}.000000`;
    const from = compareTs(lookback, oldest) < 0 ? lookback : oldest;
    let cursor: string | undefined;
    let pages = 0;
    let reached = false;
    do {
      pages += 1;
      const page = await this.call(
        "conversations.history",
        this.conn.token,
        { channel, oldest: from, limit: HISTORY_PAGE, ...(cursor === undefined ? {} : { cursor }) },
        SlackMessages,
      );
      for (const raw of page.messages) {
        const message = SlackMessage.safeParse(raw);
        if (message.success) {
          found.push(message.data);
          if (compareTs(message.data.ts, oldest) <= 0) reached = true;
        }
      }
      cursor = page.has_more === true ? page.response_metadata?.next_cursor : undefined;
      // The part after the read position must be complete; the look back before it only finds threads, a few pages of it.
    } while (cursor !== undefined && cursor !== "" && (!reached || pages < LOOKBACK_PAGES));
    await this.store(
      channel,
      found.sort((a, b) => compareTs(a.ts, b.ts)),
      oldest,
    );
    // A thread started after the position that has had replies since: its replies are asked for too.
    for (const message of found) {
      if (
        (message.reply_count ?? 0) > 0 &&
        message.latest_reply !== undefined &&
        compareTs(message.latest_reply, oldest) > 0
      ) {
        await this.replies(channel, message.ts, oldest);
      }
    }
  }

  private async replies(channel: string, root: string, oldest: string): Promise<void> {
    const found: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.call(
        "conversations.replies",
        this.conn.token,
        { channel, ts: root, oldest, limit: HISTORY_PAGE, ...(cursor === undefined ? {} : { cursor }) },
        SlackMessages,
      );
      for (const raw of page.messages) {
        const message = SlackMessage.safeParse(raw);
        // The root comes back with its replies: it is stored by the history, or already was.
        if (message.success && message.data.ts !== root) found.push(message.data);
      }
      cursor = page.has_more === true ? page.response_metadata?.next_cursor : undefined;
    } while (cursor !== undefined && cursor !== "");
    await this.store(
      channel,
      found.sort((a, b) => compareTs(a.ts, b.ts)),
      oldest,
    );
  }

  private async store(channel: string, messages: SlackMessage[], oldest: string): Promise<void> {
    for (const message of messages) {
      if (compareTs(message.ts, oldest) <= 0 || !WRITTEN.has(message.subtype)) continue;
      const delivery = await this.fromMessage(channel, message, undefined, "new");
      if (delivery === undefined) continue;
      if (!(await this.deliver(delivery, false)))
        throw new SlackNetworkError("A message could not be stored.");
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The Slack adapter: Socket Mode with the app-level token (no public address), one socket per connection. It reads, it
 * does not decide. Each envelope is answered at once; each message goes to the sink once however often Slack repeats it;
 * the read position of a channel is the ts of the newest message stored, and after a gap the channel's history is read
 * from it.
 */
export class SlackAdapter implements ChatAdapter {
  readonly app = "slack" as const;
  readonly capabilities: ChatCapabilities = { threads: true, edits: true, deletes: true, maxText: MAX_TEXT };

  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The send queue of each channel: one send at a time, in the order they were asked. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Which thread a message of a channel is in, from what was read. */
  private readonly rootOf = new Map<string, string>();
  /** What majhi posted as the owner, as `channel:ts`, recorded the moment Slack answered the post. */
  private readonly sentAsYou = new Set<string>();
  /** Who each connection's user token belongs to, asked now and then. */
  private readonly youCache = new Map<
    string,
    { token: string; at: number; who: { user: string; team: string } | undefined }
  >();

  constructor(private readonly options: SlackAdapterOptions = {}) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  start(conn: ChatConnection, sink: ChatSink, cursor: ChatCursor | undefined): () => void {
    const session = new SlackSession(
      conn,
      sink,
      cursor,
      this.options,
      this.rootOf,
      this.sentAsYou,
      () => this.youOf(conn),
      (channel) => this.queues.get(channel) ?? Promise.resolve(),
    );
    void session.run().catch((err) => {
      this.options.log?.(`slack ${conn.id}: the read loop ended: ${errorMessage(err)}`);
    });
    return () => session.stop();
  }

  channels(conn: ChatConnection): Promise<ChatChannelList> {
    return listSlackChannels(new SlackApi({ base: this.options.base, fetch: this.options.fetch }), conn);
  }

  /** The owner's user token checked against the bot's workspace. Throws a refusal with its fix. */
  async asYou(conn: ChatConnection): Promise<ChatAsYou> {
    const api = new SlackApi({ base: this.options.base, fetch: this.options.fetch });
    return checkSlackUser(api, conn);
  }

  /** Who the user token belongs to, or undefined when none is saved or it is not good. A failure is asked again soon. */
  private async youOf(conn: ChatConnection): Promise<{ user: string; team: string } | undefined> {
    const token = conn.userToken;
    if (token === undefined) return undefined;
    const now = (this.options.now?.() ?? new Date()).getTime();
    const had = this.youCache.get(conn.id);
    if (had !== undefined && had.token === token && now - had.at < (had.who === undefined ? 30_000 : 600_000))
      return had.who;
    let who: { user: string; team: string } | undefined;
    try {
      const api = new SlackApi({ base: this.options.base, fetch: this.options.fetch });
      const mine = await api.call("auth.test", token, {}, SlackAuth);
      const bot = await api.call("auth.test", conn.token, {}, SlackAuth);
      if (mine.team_id === bot.team_id) who = { user: mine.user_id, team: mine.team_id };
    } catch (err) {
      this.options.log?.(`slack ${conn.id}: the user token was not checked: ${errorMessage(err)}`);
    }
    this.youCache.set(conn.id, { token, at: now, who });
    return who;
  }

  join(conn: ChatConnection, channel: string): Promise<void> {
    return joinSlackChannel(
      new SlackApi({ base: this.options.base, fetch: this.options.fetch }),
      conn,
      channel,
    );
  }

  // -------------------------------------------------------------------------
  // Sending

  render(body: Body, people: People): string {
    return renderSlack(body, people);
  }

  send(
    conn: ChatConnection,
    target: ChatTarget,
    message: ChatMessage,
  ): Promise<{ message: string; as?: "you" }> {
    const previous = this.queues.get(target.chat) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.sendNow(conn, target, message));
    this.queues.set(target.chat, run);
    void run
      .catch(() => undefined)
      .then(() => {
        if (this.queues.get(target.chat) === run) this.queues.delete(target.chat);
      });
    return run;
  }

  private async sendNow(
    conn: ChatConnection,
    target: ChatTarget,
    message: ChatMessage,
  ): Promise<{ message: string; as?: "you" }> {
    const api = new SlackApi({ base: this.options.base, fetch: this.options.fetch });
    // A reply to a message goes to its thread: the root when the message is in one, else the message starts it.
    const thread =
      target.thread ??
      (target.replyTo === undefined
        ? undefined
        : (this.rootOf.get(`${target.chat}:${target.replyTo}`) ?? target.replyTo));
    const parts = packBody(
      message.body,
      MAX_TEXT,
      (part) => this.render(part, message.people),
      (part) => renderPlain(part, message.people),
    );
    let last = "";
    let asYou = false;
    if (target.asYou === true && (conn.userToken === undefined || (await this.youOf(conn)) === undefined)) {
      // A chat set to Me never falls back to the bot: the reply waits and the owner is told what to fix.
      await this.asYou(conn);
      throw new ChatSendError("Slack does not accept your User OAuth Token.", "rejected");
    }
    for (const part of parts) {
      const you = target.asYou === true ? conn.userToken : undefined;
      const sent = await this.sendPart(
        api,
        conn,
        target.chat,
        thread,
        this.render(part, message.people),
        you,
      );
      last = sent.ts;
      asYou = sent.asYou;
    }
    return { message: last, ...(asYou ? { as: "you" as const } : {}) };
  }

  private async sendPart(
    api: SlackApi,
    conn: ChatConnection,
    channel: string,
    thread: string | undefined,
    text: string,
    userToken: string | undefined,
  ): Promise<{ ts: string; asYou: boolean }> {
    const token = userToken ?? conn.token;
    for (let attempt = 1; ; attempt++) {
      try {
        const sent = await api.call(
          "chat.postMessage",
          token,
          { channel, text, mrkdwn: true, ...(thread === undefined ? {} : { thread_ts: thread }) },
          SlackPosted,
        );
        // Recorded before anything else can read Slack's echo of it.
        const asYou = token !== conn.token;
        if (asYou) this.rememberSent(`${channel}:${sent.ts}`);
        return { ts: sent.ts, asYou };
      } catch (err) {
        if (err instanceof SlackError && token !== conn.token) {
          if (err.code === "ratelimited" && attempt < CALL_TRIES) {
            await this.sleep(((err.retryAfter ?? 1) + 0.25) * 1000);
            continue;
          }
          if (err.badToken) {
            this.youCache.delete(conn.id);
            await this.asYou(conn);
            throw new ChatSendError("Slack does not accept your User OAuth Token.", "rejected");
          }
          if (err.unreachable)
            throw new ChatSendError("The app cannot write to that channel any more.", "unreachable");
          if (err.code === "missing_scope") {
            const needed = err.needed ?? "chat:write";
            throw new ChatSendError(
              `Slack needs the user scope ${needed} to post as you. In the Slack app add it under User Token Scopes, press Reinstall to Workspace, then copy the User OAuth Token again.`,
              "rejected",
              `user:${needed}`,
            );
          }
          throw new ChatSendError(err.plain, "rejected");
        }
        if (err instanceof SlackError) {
          if (err.code === "ratelimited" && attempt < CALL_TRIES) {
            await this.sleep(((err.retryAfter ?? 1) + 0.25) * 1000);
            continue;
          }
          if (err.badToken) throw new ChatSendError("Slack no longer accepts the bot token.", "needs-token");
          if (err.unreachable)
            throw new ChatSendError("The app cannot write to that channel any more.", "unreachable");
          throw new ChatSendError(err.plain, "rejected", err.needed);
        }
        throw err;
      }
    }
  }

  private rememberSent(key: string): void {
    this.sentAsYou.add(key);
    if (this.sentAsYou.size > SEEN_LIMIT) {
      const oldest = this.sentAsYou.values().next().value;
      if (oldest !== undefined) this.sentAsYou.delete(oldest);
    }
  }

  // -------------------------------------------------------------------------
  // Files

  async file(conn: ChatConnection, ref: ChatFileRef): Promise<{ path: string; type: string; bytes: number }> {
    if (ref.bytes !== undefined && ref.bytes > FILE_CAP_BYTES) {
      throw new ChatSendError("The file is over 20 MB.", "rejected");
    }
    const api = new SlackApi({ base: this.options.base, fetch: this.options.fetch });
    let res: Response;
    try {
      res = await api.download(ref.id, conn.token);
    } catch (err) {
      throw new ChatSendError(
        err instanceof SlackError ? err.message : "Slack did not give the file.",
        "rejected",
      );
    }
    const type = res.headers.get("content-type") ?? ref.type ?? "application/octet-stream";
    // Without the permission to read files Slack answers with its sign-in page, not the file.
    if (type.startsWith("text/html") && ref.type?.startsWith("text/html") !== true) {
      await res.body?.cancel().catch(() => undefined);
      throw new ChatSendError(
        "Slack would not give the file: the app lacks the files:read permission.",
        "rejected",
      );
    }
    const data = await readCapped(res, FILE_CAP_BYTES);
    if (data === undefined) throw new ChatSendError("The file is over 20 MB.", "rejected");
    return saveFetched(conn.filesDir, ref.name, data, ref.type ?? type);
  }
}

/** The body of a response, or undefined once it is longer than `cap` bytes. */
async function readCapped(res: Response, cap: number): Promise<Uint8Array | undefined> {
  const reader = res.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
