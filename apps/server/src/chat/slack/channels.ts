import { z } from "zod";
import { type ChatAsYou, type ChatChannelList, type ChatConnection, ChatSendError } from "../adapter.ts";
import {
  type SlackApi,
  SlackAuth,
  SlackBotInfo,
  SlackChannelRow,
  SlackChannelsPage,
  SlackError,
} from "./api.ts";

/** More pages than this are not read: a workspace this big needs a search, not a list. */
const MAX_PAGES = 20;

const Joined = z.object({}).loose();

/** The scopes a token holds, from `auth.test`'s `x-oauth-scopes` header. Undefined when Slack did not say. */
function scopesOf(headers: Headers): string[] | undefined {
  const raw = headers.get("x-oauth-scopes");
  if (raw === null) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function refused(err: unknown): never {
  if (err instanceof SlackError) {
    if (err.badToken) throw new ChatSendError("Slack no longer accepts the bot token.", "needs-token");
    throw new ChatSendError(err.plain, "rejected", err.needed);
  }
  throw err;
}

const USER_TOKEN_STEP =
  "In the Slack app open OAuth & Permissions, add the User Token Scopes, press Reinstall to Workspace, then copy the User OAuth Token (it starts with xoxp-).";

/**
 * Checks the owner's User OAuth Token: Slack accepts it, it starts with xoxp-, and it belongs to the same workspace
 * as the bot. A refusal carries the exact step that fixes it.
 */
export async function checkSlackUser(api: SlackApi, conn: ChatConnection): Promise<ChatAsYou> {
  const token = conn.userToken;
  if (token === undefined)
    throw new ChatSendError(`No User OAuth Token is saved. ${USER_TOKEN_STEP}`, "rejected");
  if (!token.startsWith("xoxp-"))
    throw new ChatSendError(
      `That is not a User OAuth Token: it must start with xoxp-. ${USER_TOKEN_STEP}`,
      "rejected",
    );
  try {
    const mine = await api.callWithHeaders("auth.test", token, {}, SlackAuth);
    const bot = await api.call("auth.test", conn.token, {}, SlackAuth);
    if (mine.data.team_id !== bot.team_id) {
      throw new ChatSendError(
        "That User OAuth Token belongs to another Slack workspace. Copy it from this app's OAuth & Permissions page, in the workspace the app is installed in.",
        "rejected",
      );
    }
    return {
      user: mine.data.user_id,
      name: mine.data.user ?? mine.data.user_id,
      scopes: scopesOf(mine.headers),
    };
  } catch (err) {
    if (err instanceof SlackError) {
      if (err.badToken)
        throw new ChatSendError(
          `Slack does not accept that User OAuth Token. ${USER_TOKEN_STEP}`,
          "rejected",
        );
      throw new ChatSendError(err.plain, "rejected", err.needed);
    }
    throw err;
  }
}

/** Every channel the bot can see (public and private, not archived), the bot's name and the scopes of its token. */
export async function listSlackChannels(api: SlackApi, conn: ChatConnection): Promise<ChatChannelList> {
  try {
    const auth = await api.callWithHeaders("auth.test", conn.token, {}, SlackAuth);
    // Slack lists the token's scopes on every answer; the first that does is read, auth.test's before the rest.
    let scopes = scopesOf(auth.headers);
    const channels: ChatChannelList["channels"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await api.callWithHeaders(
        "conversations.list",
        conn.token,
        {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        },
        SlackChannelsPage,
      );
      scopes ??= scopesOf(got.headers);
      for (const raw of got.data.channels) {
        const row = SlackChannelRow.safeParse(raw);
        if (!row.success || row.data.is_archived === true) continue;
        channels.push({
          id: row.data.id,
          name: row.data.name ?? row.data.id,
          private: row.data.is_private === true,
          member: row.data.is_member === true,
        });
      }
      cursor = got.data.response_metadata?.next_cursor;
      if (cursor === undefined || cursor === "") break;
    }
    // The app's id names its permissions page. `bots.info` may be refused: then the page is the list of apps.
    let appId: string | undefined;
    if (auth.data.bot_id !== undefined) {
      try {
        appId = (await api.call("bots.info", conn.token, { bot: auth.data.bot_id }, SlackBotInfo)).bot.app_id;
      } catch {
        appId = undefined;
      }
    }
    let you: ChatChannelList["you"];
    if (conn.userToken !== undefined) {
      try {
        const who = await checkSlackUser(api, conn);
        you = { state: "ok", name: who.name, scopes: who.scopes };
      } catch (err) {
        if (!(err instanceof ChatSendError)) throw err;
        you = { state: "refused", fix: err.message };
      }
    }
    return {
      bot: auth.data.user ?? "majhi",
      ...(appId === undefined ? {} : { appId }),
      channels,
      scopes,
      ...(you === undefined ? {} : { you }),
    };
  } catch (err) {
    return refused(err);
  }
}

/** The bot joins a public channel. Private channels need an invite: this is never called for them. */
export async function joinSlackChannel(api: SlackApi, conn: ChatConnection, channel: string): Promise<void> {
  try {
    await api.call("conversations.join", conn.token, { channel }, Joined);
  } catch (err) {
    refused(err);
  }
}
