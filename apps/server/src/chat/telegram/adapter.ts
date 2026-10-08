import type { Body, ChatCursor, ChatEnvelope, ChatFileRef, ChatKind, ChatMention } from "@majhi/shared";
import { errorMessage } from "../../errors.ts";
import {
  type ChatAdapter,
  type ChatCapabilities,
  type ChatConnection,
  type ChatMessage,
  type ChatProbe,
  ChatSendError,
  type ChatSink,
  type ChatTarget,
  FILE_CAP_BYTES,
} from "../adapter.ts";
import { saveFetched } from "../files.ts";
import { type People, packBody, renderPlain, renderTelegramHtml } from "../format.ts";
import {
  type Fetch,
  TelegramApi,
  TelegramError,
  TelegramNetworkError,
  TgAdmins,
  TgBotMe,
  TgCount,
  TgFileInfo,
  type TgMessage,
  TgSent,
  TgUpdate,
  TgUpdates,
  TgWebhookInfo,
} from "./api.ts";

/** What Telegram may deliver: messages and their edits, in groups and channels. Set explicitly, never the default. */
export const ALLOWED_UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post"] as const;

/** Telegram's limit of one message, in characters after formatting is read. */
export const MAX_TEXT = 4096;

/** Group admins who post anonymously arrive as this user. They cannot be told apart, so they are unverified. */
const ANONYMOUS_ADMIN = 1087968824;

const LONG_POLL_SECONDS = 25;
/** After this many failed reads in a row the account shows as unreachable. */
const TROUBLE_AFTER_FAILURES = 3;
/** The most tries one send gets when Telegram says to wait. */
const SEND_TRIES = 5;
/** People counts are asked once in a while, not on every message. */
const PEOPLE_TTL_MS = 6 * 60 * 60 * 1000;

export interface TelegramAdapterOptions {
  /** Telegram's address; only a test points it elsewhere. */
  base?: string | undefined;
  fetch?: Fetch | undefined;
  /** Waits, in ms. Replaced in tests. */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  now?: (() => Date) | undefined;
  log?: ((line: string) => void) | undefined;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
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

export { splitText } from "../format.ts";

function kindOf(type: string): ChatKind {
  if (type === "channel") return "channel";
  if (type === "private") return "private";
  return "group";
}

function nameOf(user: {
  first_name?: string | undefined;
  last_name?: string | undefined;
  username?: string | undefined;
}): string {
  const full = [user.first_name, user.last_name]
    .filter((p): p is string => p !== undefined && p !== "")
    .join(" ");
  return full !== "" ? full : (user.username ?? "Unknown");
}

function fileRefs(msg: TgMessage): ChatFileRef[] {
  const out: ChatFileRef[] = [];
  const add = (
    file:
      | {
          file_id: string;
          file_size?: number | undefined;
          file_name?: string | undefined;
          mime_type?: string | undefined;
        }
      | undefined,
    fallback: string,
  ) => {
    if (file === undefined) return;
    out.push({
      id: file.file_id,
      name: file.file_name ?? fallback,
      ...(file.mime_type === undefined ? {} : { type: file.mime_type }),
      ...(file.file_size === undefined ? {} : { bytes: file.file_size }),
    });
  };
  add(msg.document, "file");
  // Telegram sends a photo in several sizes: the last is the largest.
  add(msg.photo?.at(-1), "photo.jpg");
  add(msg.video, "video.mp4");
  add(msg.audio, "audio");
  add(msg.voice, "voice.ogg");
  add(msg.animation, "animation.mp4");
  add(msg.video_note, "video-note.mp4");
  add(msg.sticker, "sticker.webp");
  return out;
}

/**
 * One Telegram update as the envelope majhi stores, or undefined when it is not a message: a join, a pin, a
 * title change. The bot's own messages and every bot are marked as bots; the hub drops those. Identity is the
 * numeric user id, never a name. A forwarded message counts as the person who forwarded it.
 */
export function toEnvelope(
  update: TgUpdate,
  account: string,
  people: (chat: string) => number | undefined,
  staff: (chat: string) => ReadonlySet<string> | undefined = () => undefined,
): ChatEnvelope | undefined {
  const edit = update.edited_message ?? update.edited_channel_post;
  const msg = update.message ?? update.channel_post ?? edit;
  if (msg === undefined) return undefined;
  const chat = String(msg.chat.id);
  const info = {
    title: msg.chat.title ?? nameOf(msg.chat),
    kind: kindOf(msg.chat.type),
    ...(people(chat) === undefined ? {} : { people: people(chat) }),
  };
  const external = { app: "telegram" as const, account, chat, message: String(msg.message_id) };
  if (msg.migrate_to_chat_id !== undefined) {
    return {
      kind: "new",
      external,
      chat: info,
      sender: { id: "telegram", name: "Telegram", bot: true, verified: false },
      text: "",
      files: [],
      at: new Date(msg.date * 1000).toISOString(),
      movedTo: String(msg.migrate_to_chat_id),
    };
  }
  const text = msg.text ?? msg.caption ?? "";
  const files = fileRefs(msg);
  // A service message (someone joined, the title changed) says nothing a client wrote.
  if (text === "" && files.length === 0) return undefined;
  const channelSender = msg.sender_chat !== undefined || msg.from === undefined;
  const anonymous = msg.from?.id === ANONYMOUS_ADMIN;
  const sender =
    channelSender || anonymous
      ? {
          id: String(msg.sender_chat?.id ?? msg.chat.id),
          name: msg.sender_chat?.title ?? msg.chat.title ?? "Unknown",
          bot: false,
          verified: false,
        }
      : {
          id: String(msg.from?.id),
          name: nameOf(msg.from ?? { first_name: "Unknown" }),
          ...(msg.from?.username === undefined ? {} : { username: msg.from.username }),
          bot: msg.from?.is_bot === true,
          verified: true,
          ...(staff(chat)?.has(String(msg.from?.id)) === true ? { staff: true as const } : {}),
        };
  const at = edit === undefined ? msg.date : (edit.edit_date ?? edit.date);
  const mentions = mentionsOf(msg, text);
  const bot = account.startsWith("@") ? account.slice(1).toLowerCase() : account.toLowerCase();
  const addressed =
    mentions.some((m) => m.username?.toLowerCase() === bot) ||
    (msg.reply_to_message?.from?.is_bot === true &&
      msg.reply_to_message.from.username?.toLowerCase() === bot);
  return {
    kind: edit === undefined ? "new" : "edit",
    external,
    chat: info,
    sender,
    text,
    files,
    at: new Date(at * 1000).toISOString(),
    ...(msg.is_topic_message === true && msg.message_thread_id !== undefined
      ? { thread: String(msg.message_thread_id) }
      : {}),
    ...(msg.reply_to_message === undefined ? {} : { replyTo: String(msg.reply_to_message.message_id) }),
    ...(msg.forward_origin !== undefined || msg.forward_date !== undefined ? { forwarded: true } : {}),
    ...(mentions.length === 0 ? {} : { mentions }),
    ...(addressed ? { addressed: true } : {}),
  };
}

/**
 * The people a message names. A `text_mention` carries the user (a person with no @handle); a `mention` is
 * an @handle in the text. Offsets are UTF-16 units of the message text, which is a JS string index.
 */
function mentionsOf(msg: TgMessage, text: string): ChatMention[] {
  const entities = msg.text === undefined ? msg.caption_entities : msg.entities;
  const out: ChatMention[] = [];
  for (const entity of entities ?? []) {
    const end = entity.offset + entity.length;
    if (entity.type === "text_mention" && entity.user !== undefined) {
      out.push({
        start: entity.offset,
        end,
        native: String(entity.user.id),
        ...(entity.user.username === undefined ? {} : { username: entity.user.username }),
      });
    } else if (entity.type === "mention") {
      const word = text.slice(entity.offset, end);
      if (word.startsWith("@") && word.length > 1)
        out.push({ start: entity.offset, end, username: word.slice(1) });
    }
  }
  return out;
}

/**
 * The Telegram adapter: long polling with `getUpdates` (no public address), one loop per token. It reads, it
 * does not decide: each update goes to the sink, and the read position moves only after the whole batch is stored.
 */
export class TelegramAdapter implements ChatAdapter {
  readonly app = "telegram" as const;
  readonly capabilities: ChatCapabilities = {
    threads: true,
    edits: true,
    deletes: false,
    maxText: MAX_TEXT,
    retentionHours: 24,
  };

  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => Date;
  /** The send queue of each chat: one send at a time, in the order they were asked. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly adminCache = new Map<string, { ids: Set<string>; at: number }>();
  private readonly peopleCache = new Map<string, { n: number | undefined; at: number }>();

  constructor(private readonly options: TelegramAdapterOptions = {}) {
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => new Date());
  }

  private api(conn: ChatConnection): TelegramApi {
    return new TelegramApi({ token: conn.token, base: this.options.base, fetch: this.options.fetch });
  }

  async probe(conn: ChatConnection): Promise<ChatProbe> {
    const api = this.api(conn);
    const me = await api.call("getMe", {}, TgBotMe);
    const hook = await api.call("getWebhookInfo", {}, TgWebhookInfo);
    return {
      app: "telegram",
      bot: me.username ?? me.first_name,
      canJoinGroups: me.can_join_groups !== false,
      readsAllGroupMessages: me.can_read_all_group_messages === true,
      webhook: hook.url === "" ? undefined : hook.url,
    };
  }

  start(conn: ChatConnection, sink: ChatSink, cursor: ChatCursor | undefined): () => void {
    const stop = new AbortController();
    void this.loop(conn, sink, cursor, stop.signal).catch((err) => {
      this.options.log?.(`telegram ${conn.id}: the read loop ended: ${errorMessage(err)}`);
    });
    return () => stop.abort();
  }

  private async loop(
    conn: ChatConnection,
    sink: ChatSink,
    cursor: ChatCursor | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const api = this.api(conn);
    let offset = Number(cursor?.position.offset ?? "");
    if (!Number.isFinite(offset) || offset <= 0) offset = 0;
    let failures = 0;
    let healthy = false;
    while (!signal.aborted) {
      try {
        const raw = await api.call(
          "getUpdates",
          {
            ...(offset > 0 ? { offset } : {}),
            timeout: LONG_POLL_SECONDS,
            allowed_updates: [...ALLOWED_UPDATES],
          },
          TgUpdates,
          signal,
        );
        if (!healthy) {
          healthy = true;
          sink.trouble(undefined);
        }
        failures = 0;
        if (raw.length === 0) continue;
        let top = offset;
        for (const entry of raw) {
          const id =
            typeof entry === "object" && entry !== null && "update_id" in entry
              ? Number(entry.update_id)
              : NaN;
          if (!Number.isFinite(id)) continue;
          const update = TgUpdate.safeParse(entry);
          if (update.success) {
            const msg =
              update.data.message ??
              update.data.channel_post ??
              update.data.edited_message ??
              update.data.edited_channel_post;
            if (msg !== undefined) {
              await this.people(api, String(msg.chat.id), signal);
              if (msg.chat.type !== "private") await this.admins(api, String(msg.chat.id), signal);
            }
            const envelope = toEnvelope(
              update.data,
              conn.account,
              (chat) => this.peopleCache.get(chat)?.n,
              (chat) => this.adminCache.get(chat)?.ids,
            );
            if (envelope !== undefined) await sink.deliver(envelope);
          }
          top = Math.max(top, id + 1);
        }
        // Only now, with every delivery of the batch stored, does the read position move.
        offset = top;
        sink.save({ position: { offset: String(offset) }, at: this.now().toISOString() });
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramError) {
          if (err.code === 401) {
            sink.trouble("needs-token");
            return;
          }
          if (err.code === 409) {
            sink.trouble("webhook");
            return;
          }
          if (err.code === 429) {
            await this.sleep(((err.retryAfter ?? 1) + 1) * 1000, signal);
            continue;
          }
        }
        failures += 1;
        if (failures >= TROUBLE_AFTER_FAILURES) {
          healthy = false;
          sink.trouble("unreachable");
        }
        this.options.log?.(
          `telegram ${conn.id}: ${err instanceof TelegramNetworkError || err instanceof TelegramError ? err.message : errorMessage(err)}`,
        );
        await this.sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), signal);
      }
    }
  }

  /** Who administers a group, asked once in a while: an admin may be one of us, so the owner is asked once. */
  private async admins(api: TelegramApi, chat: string, signal: AbortSignal): Promise<void> {
    const cached = this.adminCache.get(chat);
    if (cached !== undefined && this.now().getTime() - cached.at < PEOPLE_TTL_MS) return;
    try {
      const list = await api.call("getChatAdministrators", { chat_id: chat }, TgAdmins, signal);
      this.adminCache.set(chat, {
        ids: new Set(list.map((a) => String(a.user.id))),
        at: this.now().getTime(),
      });
    } catch {
      this.adminCache.set(chat, { ids: cached?.ids ?? new Set(), at: this.now().getTime() });
    }
  }

  private async people(api: TelegramApi, chat: string, signal: AbortSignal): Promise<void> {
    const cached = this.peopleCache.get(chat);
    if (cached !== undefined && this.now().getTime() - cached.at < PEOPLE_TTL_MS) return;
    try {
      const n = await api.call("getChatMemberCount", { chat_id: chat }, TgCount, signal);
      this.peopleCache.set(chat, { n, at: this.now().getTime() });
    } catch {
      // The count is a nicety: a chat without it still works.
      this.peopleCache.set(chat, { n: cached?.n, at: this.now().getTime() });
    }
  }

  // -------------------------------------------------------------------------
  // Sending

  render(body: Body, people: People): string {
    return renderTelegramHtml(body, people);
  }

  send(conn: ChatConnection, target: ChatTarget, message: ChatMessage): Promise<{ message: string }> {
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
  ): Promise<{ message: string }> {
    const api = this.api(conn);
    let last = "";
    let first = true;
    const parts = packBody(
      message.body,
      MAX_TEXT,
      (part) => this.render(part, message.people),
      (part) => renderPlain(part, message.people),
    );
    for (const part of parts) {
      last = await this.sendPart(
        api,
        target,
        { html: this.render(part, message.people), plain: renderPlain(part, message.people) },
        first,
      );
      first = false;
    }
    return { message: last };
  }

  private async sendPart(
    api: TelegramApi,
    target: ChatTarget,
    text: { html: string; plain: string },
    first: boolean,
  ): Promise<string> {
    // Telegram wants a whole number; anything else sends without the reply link rather than failing.
    const replyId = target.replyTo === undefined ? undefined : Number(target.replyTo);
    const base: Record<string, unknown> = {
      chat_id: target.chat,
      ...(target.thread === undefined ? {} : { message_thread_id: Number(target.thread) }),
      ...(first && replyId !== undefined && Number.isSafeInteger(replyId)
        ? { reply_parameters: { message_id: replyId, allow_sending_without_reply: true } }
        : {}),
    };
    let html = true;
    for (let attempt = 1; ; attempt++) {
      try {
        const sent = await api.call(
          "sendMessage",
          html ? { ...base, text: text.html, parse_mode: "HTML" } : { ...base, text: text.plain },
          TgSent,
        );
        return String(sent.message_id);
      } catch (err) {
        if (!(err instanceof TelegramError)) throw err;
        if (err.code === 429 && attempt < SEND_TRIES) {
          await this.sleep(((err.retryAfter ?? 1) + 1) * 1000);
          continue;
        }
        if (err.code === 400 && html && err.message.toLowerCase().includes("parse")) {
          // Telegram could not read the formatting: send the words as they are.
          html = false;
          continue;
        }
        if (err.code === 401)
          throw new ChatSendError("Telegram no longer accepts the bot token.", "needs-token");
        if (err.code === 403 || (err.code === 400 && err.message.toLowerCase().includes("chat not found"))) {
          throw new ChatSendError("The bot cannot write to that chat any more.", "unreachable");
        }
        throw new ChatSendError(err.message, "rejected");
      }
    }
  }

  // -------------------------------------------------------------------------
  // Files

  async file(conn: ChatConnection, ref: ChatFileRef): Promise<{ path: string; type: string; bytes: number }> {
    if (ref.bytes !== undefined && ref.bytes > FILE_CAP_BYTES) {
      throw new ChatSendError("The file is over 20 MB.", "rejected");
    }
    const api = this.api(conn);
    const info = await api.call("getFile", { file_id: ref.id }, TgFileInfo);
    if (info.file_path === undefined)
      throw new ChatSendError("Telegram gave no path for the file.", "rejected");
    if (info.file_size !== undefined && info.file_size > FILE_CAP_BYTES) {
      throw new ChatSendError("The file is over 20 MB.", "rejected");
    }
    const res = await api.download(info.file_path);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > FILE_CAP_BYTES) throw new ChatSendError("The file is over 20 MB.", "rejected");
    return saveFetched(
      conn.filesDir,
      ref.name,
      data,
      ref.type ?? res.headers.get("content-type") ?? "application/octet-stream",
    );
  }
}
