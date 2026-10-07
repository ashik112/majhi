import { join } from "node:path";
import {
  CHAT_APP_LABEL,
  type ChatApp,
  type ChatHolder,
  CLIENT_CHAT_BRIEF,
  type ClientList,
  type ClientRoom,
  type ClientRow,
  LOCAL_TASK_PREFIX,
  type RoomItem,
  type Task,
  type TaskId,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";

export interface RoomsDeps {
  store: Store;
  room: Pick<RoomService, "post" | "publishTask">;
  majhiHome: string;
  /** Whether a workspace exists. */
  knownOrg: (org: string) => Promise<boolean>;
  /** Tells the tabs that the clients changed. */
  changed: () => void;
  now?: () => Date;
}

/**
 * Client rooms: a chat of a chat app as a room. A room is a `chat` task with the client brief and a `client` column
 * (the chat it is). Until the owner links it to a workspace it has no org: a New chat, never read by the captain.
 */
export class ClientRooms {
  constructor(private readonly deps: RoomsDeps) {}

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  room(id: string): RoomRow {
    const found = this.deps.store.client.room(id);
    if (found === undefined) throw new UserError(`There is no client chat ${id}.`, 404);
    return found;
  }

  find(app: ChatApp, account: string, chat: string): RoomRow | undefined {
    return this.deps.store.client.roomOfChat(app, account, chat);
  }

  /** The room of a chat, made when the chat is new. It is a New chat until linked. */
  open(chat: ClientRoom): RoomRow {
    const found = this.find(chat.app, chat.account, chat.chat);
    if (found !== undefined) return found;
    const { store } = this.deps;
    const id = store.tasks.allocateKey(LOCAL_TASK_PREFIX) as TaskId;
    const at = this.at();
    const title = chat.title === "" ? `${CHAT_APP_LABEL[chat.app]} chat` : chat.title;
    const task: Task = {
      id,
      title,
      brief: CLIENT_CHAT_BRIEF,
      kind: "chat",
      status: "inbox",
      // Fetched files of the chat are kept here.
      folder: join(this.deps.majhiHome, "chat-files", id),
      repos: [],
      team: [],
      mode: "lead",
      overrides: {},
      links: [],
      attachments: [],
      createdAt: at,
      updatedAt: at,
    };
    store.tasks.insert(task);
    store.client.setChat(id, { ...chat, title }, at);
    this.deps.changed();
    return { id, org: undefined, chat: { ...chat, title } };
  }

  /** The chat's name, size and state as the app last said it. */
  refresh(room: RoomRow, info: { title: string; people?: number | undefined }): RoomRow {
    const next: ClientRoom = {
      ...room.chat,
      title: info.title === "" ? room.chat.title : info.title,
      ...(info.people === undefined ? {} : { people: info.people }),
    };
    if (next.title === room.chat.title && next.people === room.chat.people) return room;
    this.deps.store.client.setChat(room.id, next, this.at());
    if (next.title !== room.chat.title) {
      this.deps.store.tasks.setText(room.id, next.title, CLIENT_CHAT_BRIEF, this.at());
    }
    this.deps.changed();
    return { ...room, chat: next };
  }

  patch(room: RoomRow, change: Partial<ClientRoom>): RoomRow {
    const next: ClientRoom = { ...room.chat, ...change };
    // `undefined` removes a flag.
    for (const key of Object.keys(change) as (keyof ClientRoom)[]) {
      if (change[key] === undefined) delete next[key];
    }
    this.deps.store.client.setChat(room.id, next, this.at());
    this.deps.changed();
    return { ...room, chat: next };
  }

  /** Links a New chat to a workspace. From then on its messages are read and triaged. */
  async link(id: string, org: string): Promise<RoomRow> {
    const room = this.room(id);
    if (!(await this.deps.knownOrg(org))) throw new UserError(`There is no workspace "${org}".`, 404);
    if (room.org !== undefined && room.org !== org) {
      throw new UserError("That chat is linked to another workspace already.", 409);
    }
    this.deps.store.client.setOrg(id, org, this.at());
    const linked = this.patch(room, { ignored: undefined });
    const task = this.deps.store.tasks.get(id);
    if (task !== undefined) this.deps.room.publishTask(task);
    return { ...linked, org };
  }

  /** The owner does not want this chat read. What arrives from it is dropped. */
  ignore(id: string): RoomRow {
    const room = this.room(id);
    if (room.org !== undefined)
      throw new UserError("A linked chat is not ignored. Remove the bot from it instead.", 409);
    return this.patch(room, { ignored: true });
  }

  holder(id: string, holder: ChatHolder): RoomRow {
    return this.patch(this.room(id), { holder });
  }

  /** Every linked chat with what the list shows, and the chats not linked yet. */
  list(): Omit<ClientList, "accounts"> {
    const { store } = this.deps;
    const rooms = store.client.rooms();
    const conversations = new Map(store.conversations.list().map((c) => [c.id, c]));
    const held = store.client.heldRooms();
    const clients: ClientRow[] = [];
    const newChats: ClientRow[] = [];
    for (const r of rooms) {
      if (r.chat.ignored === true) continue;
      const conversation = conversations.get(r.id);
      const row: ClientRow = {
        id: r.id,
        app: r.chat.app,
        title: r.chat.title,
        kind: r.chat.kind,
        ...(r.chat.people === undefined ? {} : { people: r.chat.people }),
        ...(r.org === undefined ? {} : { org: r.org }),
        holder: r.chat.holder,
        ...(r.chat.trouble === undefined ? {} : { trouble: r.chat.trouble }),
        ...(conversation === undefined
          ? {}
          : { lastLine: conversation.lastLine, lastAt: conversation.lastAt }),
        unread: conversation?.unread ?? 0,
        waiting: held.has(r.id),
      };
      (r.org === undefined ? newChats : clients).push(row);
    }
    const byRecent = (a: ClientRow, b: ClientRow) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
    return { clients: clients.toSorted(byRecent), newChats };
  }

  /** The text of a room's newest items of a type, newest first. */
  items(room: string, type: RoomItem["type"], limit: number): RoomItem[] {
    return this.deps.store.room
      .page(room, 200)
      .items.filter((i) => i.type === type)
      .slice(0, limit);
  }
}
