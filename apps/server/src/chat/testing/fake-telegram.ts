import { createServer, type Server } from "node:http";
import type { Fetch } from "../telegram/api.ts";

/**
 * A fake of Telegram's Bot API, for tests and for trying majhi without Telegram: it holds updates the way Telegram does
 * (an update stays until a `getUpdates` with a higher offset confirms it), answers the methods majhi calls, and records
 * what was sent. Nothing here reaches a real server.
 */

export interface FakeChat {
  id: number;
  type: "group" | "supergroup" | "private" | "channel";
  title?: string;
}

export interface FakeUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
}

export interface FakeMessage {
  chat: FakeChat;
  from?: FakeUser;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name: string; file_size: number; mime_type?: string };
  reply_to?: number;
  thread?: number;
  forward?: boolean;
  migrate_to_chat_id?: number;
}

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export interface SentMessage {
  chat: string;
  text: string;
  parse_mode?: string;
  thread?: number;
  reply_to?: number;
}

type Failure = { error_code: number; description: string; parameters?: Record<string, unknown> };

export class FakeTelegram {
  static readonly TOKEN = "123456:fake-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  readonly calls: Call[] = [];
  readonly sent: SentMessage[] = [];
  readonly files = new Map<string, Uint8Array>();
  webhook = "";
  private updates: { update_id: number; [key: string]: unknown }[] = [];
  private nextUpdate = 1;
  private nextMessage = 100;
  private readonly failures = new Map<string, Failure[]>();
  private waiter: (() => void) | undefined;

  constructor(
    readonly bot: { id: number; username: string } = { id: 999, username: "majhi_test_bot" },
    /** How long an empty getUpdates holds, in ms. A real long poll holds for `timeout` seconds. */
    private readonly holdMs = 20,
  ) {}

  /** A message arrives. Returns its update id. */
  push(message: FakeMessage, kind: "message" | "edited_message" = "message", messageId?: number): number {
    const id = this.nextUpdate++;
    const message_id = messageId ?? this.nextMessage++;
    const body: Record<string, unknown> = {
      message_id,
      chat: message.chat,
      date: Math.floor(Date.now() / 1000),
      ...(message.from === undefined ? {} : { from: { is_bot: false, ...message.from } }),
      ...(message.text === undefined ? {} : { text: message.text }),
      ...(message.caption === undefined ? {} : { caption: message.caption }),
      ...(message.document === undefined ? {} : { document: message.document }),
      ...(message.reply_to === undefined ? {} : { reply_to_message: { message_id: message.reply_to } }),
      ...(message.thread === undefined ? {} : { message_thread_id: message.thread, is_topic_message: true }),
      ...(message.forward === true ? { forward_origin: { type: "user" }, forward_date: 1 } : {}),
      ...(message.migrate_to_chat_id === undefined ? {} : { migrate_to_chat_id: message.migrate_to_chat_id }),
      ...(kind === "edited_message" ? { edit_date: Math.floor(Date.now() / 1000) } : {}),
    };
    this.updates.push({ update_id: id, [kind]: body });
    this.waiter?.();
    return id;
  }

  /** The next call of this method fails with this answer. */
  failNext(method: string, failure: Failure): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), failure]);
  }

  /** The `offset` of each getUpdates call, in order. */
  offsets(): (number | undefined)[] {
    return this.calls
      .filter((c) => c.method === "getUpdates")
      .map((c) => c.params.offset as number | undefined);
  }

  /** What is still held, unconfirmed. */
  pending(): number[] {
    return this.updates.map((u) => u.update_id);
  }

  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const signal = init?.signal ?? undefined;
    const parts = url.pathname.split("/").filter((p) => p !== "");
    if (parts[0] === "file") {
      const data = this.files.get(parts.slice(2).join("/"));
      return data === undefined
        ? new Response("not found", { status: 404 })
        : new Response(Buffer.from(data), { headers: { "content-type": "application/octet-stream" } });
    }
    const method = parts[1] ?? "";
    const params = (
      init?.body === undefined || init.body === null ? {} : JSON.parse(String(init.body))
    ) as Record<string, unknown>;
    this.calls.push({ method, params });
    const failure = this.failures.get(method)?.shift();
    if (failure !== undefined) return json({ ok: false, ...failure });
    const result = await this.answer(method, params, signal);
    return json({ ok: true, result });
  };

  private async answer(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "getMe":
        return { id: this.bot.id, is_bot: true, first_name: "Majhi test", username: this.bot.username };
      case "getWebhookInfo":
        return { url: this.webhook };
      case "deleteWebhook":
        this.webhook = "";
        return true;
      case "getChatMemberCount":
        return 4;
      case "getUpdates": {
        const offset = typeof params.offset === "number" ? params.offset : 0;
        // A higher offset confirms everything below it.
        this.updates = this.updates.filter((u) => u.update_id >= offset);
        if (this.updates.length === 0) await this.hold(signal);
        return [...this.updates];
      }
      case "sendMessage": {
        this.sent.push({
          chat: String(params.chat_id),
          text: String(params.text),
          ...(typeof params.parse_mode === "string" ? { parse_mode: params.parse_mode } : {}),
          ...(typeof params.message_thread_id === "number" ? { thread: params.message_thread_id } : {}),
          ...(typeof (params.reply_parameters as { message_id?: number } | undefined)?.message_id === "number"
            ? { reply_to: (params.reply_parameters as { message_id: number }).message_id }
            : {}),
        });
        return { message_id: this.nextMessage++ };
      }
      case "getFile": {
        const path = `docs/${String(params.file_id)}`;
        const data = this.files.get(path);
        return { file_path: path, ...(data === undefined ? {} : { file_size: data.byteLength }) };
      }
      default:
        return true;
    }
  }

  private hold(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiter = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.holdMs);
      this.waiter = done;
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          this.waiter = undefined;
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  /** The same fake behind a real http port, for trying majhi against it. */
  serve(port: number): Promise<Server> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        void (async () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const abort = new AbortController();
          res.on("close", () => abort.abort());
          const answer = await this.fetch(`http://fake${req.url ?? "/"}`, {
            method: req.method ?? "POST",
            ...(body === "" ? {} : { body }),
            signal: abort.signal,
          }).catch(() => undefined);
          if (answer === undefined) {
            res.statusCode = 499;
            res.end();
            return;
          }
          res.statusCode = answer.status;
          res.setHeader("content-type", answer.headers.get("content-type") ?? "application/json");
          res.end(Buffer.from(await answer.arrayBuffer()));
        })();
      });
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
