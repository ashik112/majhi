import {
  type AuthorityChoice,
  type ChatApp,
  type ChatChannels,
  type ChatPermission,
  type ChatPermissionState,
  type ChatReplyInput,
  type ChatSendAs,
  type ClientList,
  type ClientRow,
  type CommandMeta,
  type ContactView,
  type HoldsPatch,
  REPLY_HOLD_LABEL,
  SLACK_SCOPE_USE,
  SLACK_USER_SCOPE_USE,
  SLACK_USER_SCOPES,
  slackChatScopes,
  slackManifest,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { type ChatChannelList, ChatSendError } from "./adapter.ts";
import type { Contacts } from "./contacts.ts";
import type { ChatConnectionInfo, ChatHub } from "./hub.ts";
import type { ChatIngest } from "./ingest.ts";
import type { ClientReplies } from "./replies.ts";
import type { ClientRooms } from "./rooms.ts";

export interface ClientChatDeps {
  store: Store;
  room: Pick<RoomService, "post" | "get">;
  rooms: ClientRooms;
  contacts: Contacts;
  replies: ClientReplies;
  ingest: ChatIngest;
  hub: Pick<ChatHub, "accounts" | "capabilities" | "restart" | "channels" | "join" | "notesOf" | "checkYou">;
  /** The chat app connections that exist now. */
  connections: () => Promise<ChatConnectionInfo[]>;
  /** The owner's Hold list of a workspace, as saved. */
  savedHolds: (org: string) => Promise<HoldsPatch | undefined>;
  /** The Tell row of a workspace now. */
  tell: (org: string) => Promise<AuthorityChoice>;
  /** The captain, and the workspace of a task that is its lane. */
  lane: (task: string) => Promise<{ boss: string; org: string } | undefined>;
  /** Removes Telegram's webhook so majhi may read with getUpdates. */
  deleteWebhook: (connection: string) => Promise<void>;
  /** Saves the owner's User OAuth Token on a Slack connection, in secrets.age. */
  saveUserToken: (connection: string, userToken: string, meta: CommandMeta) => Promise<void>;
}

/** How long a channel list from the app is reused. */
const CHANNELS_TTL_MS = 30_000;

/** What the commands of client chats do. The handlers only check who asks and call these. */
export class ClientChat {
  private readonly listed = new Map<
    string,
    { at: number; info: ChatConnectionInfo; list: ChatChannelList }
  >();

  constructor(private readonly deps: ClientChatDeps) {}

  private async fetched(connection: string, fresh: boolean) {
    const had = this.listed.get(connection);
    if (!fresh && had !== undefined && Date.now() - had.at < CHANNELS_TTL_MS) return had;
    const { info, list } = await this.deps.hub.channels(connection);
    const made = { at: Date.now(), info, list };
    this.listed.set(connection, made);
    return made;
  }

  /** The channels of a connection's workspace, with what majhi has done with each. */
  async channels(connection: string, refresh: boolean): Promise<ChatChannels> {
    const { info, list } = await this.fetched(connection, refresh);
    const notes = this.deps.hub.notesOf(connection);
    const channels = list.channels.map((c) => {
      const room = this.deps.rooms.find(info.app, info.account, c.id);
      return {
        ...c,
        ...(room === undefined ? {} : { room: room.id }),
        ...(room?.org === undefined ? {} : { org: room.org }),
        ...(room?.chat.ignored === true ? { ignored: true } : {}),
      };
    });
    // What Slack says of the token is the answer; when it says nothing, a refusal it gave majhi is, else it is not known.
    const permissions: ChatPermission[] = slackChatScopes().map((scope) => {
      const state: ChatPermissionState =
        list.scopes !== undefined
          ? list.scopes.includes(scope)
            ? "granted"
            : "missing"
          : notes.needed.includes(scope)
            ? "missing"
            : "unknown";
      return { scope, use: SLACK_SCOPE_USE[scope] ?? scope, state };
    });
    const you = list.you ?? { state: "none" as const };
    // The owner's own permissions are listed once a user token is saved.
    if (you.state !== "none") {
      const yours = you.state === "ok" ? you.scopes : undefined;
      for (const scope of SLACK_USER_SCOPES) {
        const state: ChatPermissionState =
          yours !== undefined
            ? yours.includes(scope)
              ? "granted"
              : "missing"
            : notes.needed.includes(`user:${scope}`)
              ? "missing"
              : "unknown";
        permissions.push({ scope, as: "you", use: `As you: ${SLACK_USER_SCOPE_USE[scope] ?? scope}`, state });
      }
    }
    return {
      connection,
      bot: list.bot,
      you,
      ...(list.appId === undefined ? {} : { appId: list.appId }),
      channels,
      permissions,
      socketMode: this.socketMode(connection),
      messageEvents: notes.eventSeen,
      manifest: JSON.stringify(slackManifest(list.bot, "readwrite")),
    };
  }

  /** Chooses whose name replies in one chat go out under. Me waits for a good user token at send time. */
  setSendAs(room: string, sendAs: ChatSendAs): ClientRow {
    this.deps.rooms.sendAs(room, sendAs);
    return this.row(room);
  }

  /**
   * Saves the owner's User OAuth Token on a Slack connection. It is checked first (Slack's, and of the same workspace
   * as the bot); a refusal says what to do.
   */
  async setUserToken(connection: string, userToken: string, meta: CommandMeta): Promise<void> {
    const info = (await this.deps.connections()).find((c) => c.id === connection);
    if (info === undefined || info.app !== "slack")
      throw new UserError("Only a Slack connection has a user token.", 404);
    try {
      await this.deps.hub.checkYou(connection, userToken);
    } catch (err) {
      if (err instanceof ChatSendError) throw new UserError(err.message, 409);
      throw err;
    }
    await this.deps.saveUserToken(connection, userToken, meta);
    this.listed.delete(connection);
    await this.deps.hub.restart(connection);
  }

  /** Socket Mode is on when the connection's own check opened a socket; a failed check says it is not. */
  private socketMode(connection: string): ChatPermissionState {
    const health = this.deps.store.connectionHealth.get(connection);
    if (health?.state === "connected") return "granted";
    if (health?.state === "failed") return "missing";
    return "unknown";
  }

  /** The room of a channel, made if the channel has none yet. */
  private channelRoom(info: ChatConnectionInfo, channel: ChatChannelList["channels"][number]): string {
    return this.deps.rooms.open({
      app: info.app,
      account: info.account,
      chat: channel.id,
      title: `#${channel.name}`,
      kind: "group",
      holder: "captain",
      sendAs: "bot" as const,
    }).id;
  }

  /**
   * Links a channel to a workspace the way a New chat is linked. A public channel the bot is not in is joined first;
   * a private one needs the owner's invite, so it is not linked until the bot is in.
   */
  async channelLink(connection: string, channel: string, org: string): Promise<ClientRow> {
    const { info, list } = await this.fetched(connection, true);
    const found = list.channels.find((c) => c.id === channel);
    if (found === undefined) throw new UserError("The bot cannot see that channel.", 404);
    if (!found.member) {
      if (found.private)
        throw new UserError(
          `The bot is not in that private channel yet. Type /invite @${list.bot} there.`,
          409,
        );
      await this.deps.hub.join(connection, channel);
      this.listed.delete(connection);
    }
    return this.link(this.channelRoom(info, found), org);
  }

  async channelIgnore(connection: string, channel: string): Promise<void> {
    const { info, list } = await this.fetched(connection, false);
    const found = list.channels.find((c) => c.id === channel);
    if (found === undefined) throw new UserError("The bot cannot see that channel.", 404);
    this.ignore(this.channelRoom(info, found));
  }

  async list(): Promise<ClientList> {
    const rooms = this.deps.rooms.list();
    return { ...rooms, accounts: this.deps.hub.accounts(await this.deps.connections()) };
  }

  private row(id: string): ClientRow {
    const all = this.deps.rooms.list();
    const found = [...all.clients, ...all.newChats].find((r) => r.id === id);
    if (found === undefined) throw new UserError(`There is no client chat ${id}.`, 404);
    return found;
  }

  async link(room: string, org: string): Promise<ClientRow> {
    // Nothing was stored before the link, so there are no contacts to make yet: they appear as people write.
    const linked = await this.deps.rooms.link(room, org);
    return this.row(linked.id);
  }

  ignore(room: string): void {
    this.deps.rooms.ignore(room);
  }

  unignore(room: string): void {
    this.deps.rooms.unignore(room);
    this.listed.clear();
  }

  /** Stops triage and replies for a linked chat. Its history stays, read only, under its workspace. */
  unlink(room: string): void {
    this.deps.rooms.unlink(room);
    this.listed.clear();
  }

  holder(room: string, holder: "captain" | "you"): ClientRow {
    this.deps.rooms.holder(room, holder);
    return this.row(room);
  }

  async send(room: string, text: string, replyTo: string | undefined) {
    const out = await this.deps.replies.owner({ room, text, replyTo });
    return { draft: out.draft, state: out.state };
  }

  editReply(draft: number, text: string): void {
    this.deps.replies.edit(draft, text);
  }

  /** The sender of a message is one of us, or is not. */
  markUs(room: string, item: string, us: boolean): void {
    const row = this.deps.rooms.room(room);
    const found = this.deps.room.get(room, item);
    if (row.org === undefined || found?.type !== "client")
      throw new UserError("That is not a client's message.", 404);
    const contact = this.deps.store.client.byIdentity(row.org, {
      app: found.external.app,
      account: found.external.account,
      native: found.sender.id,
    });
    if (contact === undefined)
      throw new UserError("That sender is not verified, so it cannot be marked.", 409);
    this.deps.contacts.setUs(contact.id, us);
  }

  samePerson(room: string, item: string, answer: "same" | "not-same"): void {
    this.deps.contacts.answer(room, item, answer);
  }

  contacts(org: string): ContactView[] {
    return this.deps.contacts.list(org);
  }

  merge(keep: string, merge: string) {
    return this.deps.contacts.merge(keep, merge);
  }

  undoMerge(merge: number): void {
    const record = this.deps.store.client.mergeRecord(merge);
    // The card the merge came from, if any, goes back to what the owner now says: not the same.
    const card = record === undefined ? undefined : this.cardOfMerge(merge);
    this.deps.contacts.undo(merge, card);
  }

  private cardOfMerge(merge: number): string | undefined {
    for (const room of this.deps.store.client.rooms()) {
      const hit = this.deps.store.room
        .page(room.id, 200)
        .items.some((i) => i.type === "same-person" && i.merge === merge);
      if (hit) return room.id;
    }
    return undefined;
  }

  async confirmWebhook(connection: string): Promise<void> {
    await this.deps.deleteWebhook(connection);
    await this.deps.hub.restart(connection);
  }

  /** The captain's reply, from its lane, to a client chat of its own workspace. The rails decide whether it goes. */
  async reply(
    input: ChatReplyInput,
    caller: { agent: string; task: string },
  ): Promise<{ state: "sent" | "held" | "failed"; why?: string }> {
    const lane = await this.deps.lane(caller.task);
    if (lane === undefined || lane.boss !== caller.agent) {
      throw new UserError("Only the captain writes to a client chat, from its workspace lane.", 409);
    }
    const room = this.deps.rooms.room(input.room);
    if (room.org !== lane.org) {
      throw new UserError(
        "Refused: that chat belongs to another workspace, and this lane works in its own only.",
        409,
      );
    }
    const out = await this.deps.replies.captain({
      room: input.room,
      text: input.text,
      flags: {
        promisedTime: input.promisedTime,
        money: input.money,
        security: input.security,
        severalClients: input.severalClients,
      },
      to: input.to,
      replyTo: input.replyTo,
      thread: input.thread,
    });
    if (out.state === "sent") return { state: "sent" };
    if (out.state === "failed") return { state: "failed", why: out.why };
    return { state: "held", why: REPLY_HOLD_LABEL[out.why] };
  }

  /** Whether a chat app of a kind exists. */
  hasApp(app: ChatApp): boolean {
    return this.deps.hub.capabilities(app) !== undefined;
  }
}
