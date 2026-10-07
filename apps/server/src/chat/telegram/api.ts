import { z } from "zod";

/**
 * The part of Telegram's Bot API majhi uses (https://core.telegram.org/bots/api). Every call is a POST of JSON
 * to `<base>/bot<token>/<method>`; the answer is `{ ok, result }` or `{ ok: false, error_code, description }`.
 * The token is in the URL, so no error or log line here ever carries the URL.
 */

export const TELEGRAM_BASE = "https://api.telegram.org";

export type Fetch = typeof fetch;

/** An error Telegram answered with. `retryAfter` is in seconds; `migrateTo` is the supergroup a group became. */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly retryAfter?: number,
    readonly migrateTo?: string,
  ) {
    super(message);
  }
}

/** The network failed or the answer was not Telegram's. Worth trying again later. */
export class TelegramNetworkError extends Error {}

const ErrorBody = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string().default(""),
  parameters: z
    .object({ retry_after: z.number().int().optional(), migrate_to_chat_id: z.number().optional() })
    .optional(),
});

const OkBody = z.object({ ok: z.literal(true), result: z.unknown() });

export interface TelegramApiOptions {
  token: string;
  base?: string | undefined;
  fetch?: Fetch | undefined;
}

export class TelegramApi {
  private readonly base: string;
  private readonly fetcher: Fetch;

  constructor(private readonly options: TelegramApiOptions) {
    this.base = (options.base ?? TELEGRAM_BASE).replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
  }

  /** Calls a method and checks its result against `schema`. */
  async call<T>(
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/bot${this.options.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw new TelegramNetworkError(`Telegram did not answer ${method}.`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new TelegramNetworkError(`Telegram's answer to ${method} was not JSON (HTTP ${res.status}).`);
    }
    const ok = OkBody.safeParse(body);
    if (ok.success) {
      const result = schema.safeParse(ok.data.result);
      if (!result.success)
        throw new TelegramNetworkError(`Telegram's answer to ${method} had an unexpected shape.`);
      return result.data;
    }
    const failed = ErrorBody.safeParse(body);
    if (failed.success) {
      const { error_code, description, parameters } = failed.data;
      throw new TelegramError(
        description === "" ? `Telegram refused ${method} (${error_code}).` : description,
        error_code,
        parameters?.retry_after,
        parameters?.migrate_to_chat_id === undefined ? undefined : String(parameters.migrate_to_chat_id),
      );
    }
    throw new TelegramNetworkError(`Telegram's answer to ${method} was not recognised (HTTP ${res.status}).`);
  }

  /** The bytes of a file at the path `getFile` gave. */
  async download(filePath: string, signal?: AbortSignal): Promise<Response> {
    try {
      const res = await this.fetcher(`${this.base}/file/bot${this.options.token}/${filePath}`, {
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new TelegramError(`Telegram would not give the file (HTTP ${res.status}).`, res.status);
      }
      return res;
    } catch (err) {
      if (err instanceof TelegramError || signal?.aborted === true) throw err;
      throw new TelegramNetworkError("Telegram did not answer the file download.");
    }
  }
}

// ---------------------------------------------------------------------------
// Shapes of what comes back. Only the fields majhi reads.

export const TgUser = z.object({
  id: z.number(),
  is_bot: z.boolean().default(false),
  first_name: z.string().default(""),
  last_name: z.string().optional(),
  username: z.string().optional(),
});
export type TgUser = z.infer<typeof TgUser>;

export const TgChat = z.object({
  id: z.number(),
  type: z.string(),
  title: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const File = z.object({
  file_id: z.string(),
  file_size: z.number().optional(),
  file_name: z.string().optional(),
  mime_type: z.string().optional(),
});

const TgEntity = z.object({
  type: z.string(),
  offset: z.number().int(),
  length: z.number().int(),
  user: TgUser.optional(),
});

export const TgMessage = z.object({
  message_id: z.number(),
  message_thread_id: z.number().optional(),
  is_topic_message: z.boolean().optional(),
  from: TgUser.optional(),
  sender_chat: TgChat.optional(),
  chat: TgChat,
  date: z.number(),
  edit_date: z.number().optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  entities: z.array(TgEntity).optional(),
  caption_entities: z.array(TgEntity).optional(),
  reply_to_message: z.object({ message_id: z.number(), from: TgUser.optional() }).optional(),
  forward_origin: z.unknown().optional(),
  forward_date: z.number().optional(),
  migrate_to_chat_id: z.number().optional(),
  migrate_from_chat_id: z.number().optional(),
  document: File.optional(),
  photo: z.array(File).optional(),
  video: File.optional(),
  audio: File.optional(),
  voice: File.optional(),
  animation: File.optional(),
  video_note: File.optional(),
  sticker: File.optional(),
});
export type TgMessage = z.infer<typeof TgMessage>;

export const TgUpdate = z.object({
  update_id: z.number(),
  message: TgMessage.optional(),
  edited_message: TgMessage.optional(),
  channel_post: TgMessage.optional(),
  edited_channel_post: TgMessage.optional(),
});
export type TgUpdate = z.infer<typeof TgUpdate>;

/**
 * Updates are read one by one, so a single update of a shape majhi does not know costs that update, not the
 * batch: the batch is an array of anything and each element is parsed on its own.
 */
export const TgUpdates = z.array(z.unknown());

export const TgMe = TgUser.extend({ username: z.string().optional() });

export const TgSent = z.object({ message_id: z.number() });
export const TgFileInfo = z.object({ file_path: z.string().optional(), file_size: z.number().optional() });
export const TgWebhookInfo = z.object({ url: z.string().default("") });
export const TgCount = z.number();
