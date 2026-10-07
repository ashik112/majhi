import { z } from "zod";

/**
 * The part of Slack's Web API majhi uses (https://docs.slack.dev/apis/web-api/). Every call is a POST of a form to
 * `<base>/<method>` with the token as a bearer header; the answer is `{ ok: true, ... }` or `{ ok: false, error }`,
 * and a rate limit is HTTP 429 with `Retry-After` in seconds. No error or log line here ever carries a token.
 */

export const SLACK_BASE = "https://slack.com/api";

export type Fetch = typeof fetch;

/** An error Slack answered with. `retryAfter` is in seconds. */
export class SlackError extends Error {
  constructor(
    /** Slack's own error name, like `invalid_auth` or `channel_not_found`, or `http_<status>`. */
    readonly code: string,
    readonly retryAfter?: number,
  ) {
    super(`Slack refused: ${code}`);
  }

  /** The token is not accepted, and will not be by trying again. */
  get badToken(): boolean {
    return BAD_TOKEN.has(this.code);
  }

  /** The bot cannot see or write to that channel. */
  get unreachable(): boolean {
    return UNREACHABLE.has(this.code);
  }
}

const BAD_TOKEN: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "invalid_app_token",
  "org_login_required",
]);

const UNREACHABLE: ReadonlySet<string> = new Set([
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "restricted_action",
  "access_denied",
]);

/** The network failed or the answer was not Slack's. Worth trying again later. */
export class SlackNetworkError extends Error {}

const ErrorBody = z.object({ ok: z.literal(false), error: z.string().default("unknown_error") });
const OkBody = z.object({ ok: z.literal(true) }).loose();

export interface SlackApiOptions {
  base?: string | undefined;
  fetch?: Fetch | undefined;
}

export class SlackApi {
  private readonly base: string;
  private readonly fetcher: Fetch;

  constructor(options: SlackApiOptions = {}) {
    this.base = (options.base ?? SLACK_BASE).replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
  }

  /** The address files and sockets are checked against: only Slack's own host, or the one this API was pointed at. */
  get origin(): string {
    return new URL(this.base).origin;
  }

  /** Calls a method with a token and checks what comes back against `schema`. */
  async call<T>(
    method: string,
    token: string,
    params: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return (await this.callWithHeaders(method, token, params, schema, signal)).data;
  }

  /** Like `call`, and the answer's headers too: `auth.test` lists the token's scopes in `x-oauth-scopes`. */
  async callWithHeaders<T>(
    method: string,
    token: string,
    params: Record<string, string | number | boolean | undefined>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<{ data: T; headers: Headers }> {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }
    let res: Response;
    try {
      res = await this.fetcher(`${this.base}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw new SlackNetworkError(`Slack did not answer ${method}.`);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => undefined);
      const wait = Number(res.headers.get("retry-after"));
      throw new SlackError("ratelimited", Number.isFinite(wait) && wait > 0 ? wait : 1);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SlackNetworkError(`Slack's answer to ${method} was not JSON (HTTP ${res.status}).`);
    }
    const ok = OkBody.safeParse(body);
    if (ok.success) {
      const result = schema.safeParse(ok.data);
      if (!result.success)
        throw new SlackNetworkError(`Slack's answer to ${method} had an unexpected shape.`);
      return { data: result.data, headers: res.headers };
    }
    const failed = ErrorBody.safeParse(body);
    if (failed.success) throw new SlackError(failed.data.error);
    throw new SlackNetworkError(`Slack's answer to ${method} was not recognised (HTTP ${res.status}).`);
  }

  /** A file at its private address, with the bot token. Refuses an address that is not Slack's own. */
  async download(url: string, token: string, signal?: AbortSignal): Promise<Response> {
    if (!this.ownsAddress(url)) throw new SlackError("file_address_refused");
    let res: Response;
    try {
      res = await this.fetcher(url, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (signal?.aborted === true) throw err;
      throw new SlackNetworkError("Slack did not answer the file download.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new SlackError(`http_${res.status}`);
    }
    return res;
  }

  /** Whether an address is Slack's file host, or the address this API was pointed at (a trial against a fake). */
  ownsAddress(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.origin === this.origin) return true;
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "slack.com" || parsed.hostname.endsWith(".slack.com"))
    );
  }
}

// ---------------------------------------------------------------------------
// Shapes of what comes back. Only the fields majhi reads.

export const SlackFile = z.object({
  id: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string().optional(),
  size: z.number().optional(),
  url_private: z.string().optional(),
});
export type SlackFile = z.infer<typeof SlackFile>;

/** A message as events and history carry it. */
export const SlackMessage = z.object({
  type: z.string().optional(),
  subtype: z.string().optional(),
  user: z.string().optional(),
  user_team: z.string().optional(),
  team: z.string().optional(),
  bot_id: z.string().optional(),
  text: z.string().default(""),
  ts: z.string(),
  thread_ts: z.string().optional(),
  reply_count: z.number().optional(),
  latest_reply: z.string().optional(),
  edited: z.object({ ts: z.string().optional() }).optional(),
  files: z.array(SlackFile).optional(),
});
export type SlackMessage = z.infer<typeof SlackMessage>;

export const SlackAuth = z.object({
  team_id: z.string(),
  team: z.string().optional(),
  user_id: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
});

/** One page of `conversations.list`. Each channel is parsed on its own: one of a shape majhi does not know costs that channel. */
export const SlackChannelsPage = z.object({
  channels: z.array(z.unknown()).default([]),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

export const SlackChannelRow = z.object({
  id: z.string(),
  name: z.string().optional(),
  is_private: z.boolean().optional(),
  is_member: z.boolean().optional(),
  is_archived: z.boolean().optional(),
});

export const SlackBotInfo = z.object({ bot: z.object({ app_id: z.string().optional() }) });

export const SlackOpen = z.object({ url: z.string() });

export const SlackUser = z.object({
  user: z.object({
    id: z.string(),
    name: z.string().optional(),
    real_name: z.string().optional(),
    team_id: z.string().optional(),
    is_bot: z.boolean().optional(),
    profile: z.object({ display_name: z.string().optional(), real_name: z.string().optional() }).optional(),
  }),
});

export const SlackConversation = z.object({
  channel: z.object({
    id: z.string(),
    name: z.string().optional(),
    is_im: z.boolean().optional(),
    is_mpim: z.boolean().optional(),
    num_members: z.number().optional(),
    user: z.string().optional(),
  }),
});

export const SlackMessages = z.object({
  /** Each one is parsed on its own: one message of a shape majhi does not know costs that message, not the page. */
  messages: z.array(z.unknown()).default([]),
  has_more: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

export const SlackPosted = z.object({ ts: z.string() });
