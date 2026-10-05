import {
  chatTitleFrom,
  DEFAULT_CHAT_TITLES,
  isOwnerChat,
  type MemorySettings,
  type RoomItem,
  type Task,
} from "@majhi/shared";
import { errorMessage } from "../errors.ts";
import type { Store } from "../store/index.ts";
import { Background } from "./background.ts";
import type { Extraction } from "./extraction.ts";
import { chatLines, type Housekeeper, NoHousekeeper, parseTitleReply, titlePrompt } from "./housekeeper.ts";

/** After this many more owner messages a title is checked once against the latest messages. */
export const RETITLE_AFTER = 6;
/** A chat read for memory that failed is tried again after this long. */
const RETRY_MS = 10 * 60_000;
const TITLE_CHARS = 3_000;
const RECENT_MESSAGES = 8;

export interface ChatMemoryDeps {
  store: Store;
  settings: () => Promise<MemorySettings>;
  extraction: Pick<Extraction, "fromChat">;
  housekeeper: Pick<Housekeeper, "ask">;
  /** The registered projects of the chat's org (a root chat: any) that it names or reads. */
  mentioned: (task: string) => Promise<string[]>;
  /** True while an agent is working in the chat. */
  working: (task: string) => boolean;
  /** Sets an auto title and shows it. False when the owner has renamed the chat. */
  setTitle: (task: string, title: string) => boolean;
  now?: () => Date;
}

/** What was said in a chat, oldest first: the owner's and the agent's messages. */
function said(items: readonly RoomItem[]): RoomItem[] {
  return items
    .filter((i) => (i.type === "owner" || i.type === "agent") && i.text.trim() !== "")
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * What memory and the sidebar do with chats, which rarely close. A chat is read for memory once
 * it has been quiet for a while, or when the owner starts a new chat with the same agent, using
 * only the messages since the last read (a watermark in `chat_state`). A chat gets a short title
 * after the agent's first reply, checked again after a few more messages; a title the owner set is
 * never replaced.
 */
export class ChatMemory {
  private readonly reading = new Set<string>();
  private readonly titling = new Set<string>();
  private readonly failedAt = new Map<string, number>();
  private readonly background = new Background();

  constructor(private readonly deps: ChatMemoryDeps) {}

  /** Resolves once the sweeps and titles in flight have ended. */
  idle(): Promise<void> {
    return this.background.settled();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Reads every chat that is due. Safe to run often and after a restart: a message is read once. */
  sweep(): Promise<void> {
    return this.background.track(this.sweepDue());
  }

  private async sweepDue(): Promise<void> {
    const { store } = this.deps;
    const idleMs = (await this.deps.settings()).chat_idle_minutes * 60_000;
    const chats = store.tasks.getMany(store.tasks.chatIds());
    for (const task of chats) {
      if (this.reading.has(task.id)) continue;
      const failed = this.failedAt.get(task.id);
      if (failed !== undefined && this.now().getTime() - failed < RETRY_MS) continue;
      const { extractedAt } = store.chats.get(task.id);
      // Nothing written since the last read: skip the room read. Most chats are like this, every minute.
      if (extractedAt !== undefined && !store.room.hasItemAfter(task.id, extractedAt)) continue;
      const items = said(store.room.page(task.id, 400).items);
      const fresh = items.filter((i) => extractedAt === undefined || i.at > extractedAt);
      // Something to read needs both sides: a lone message is not a conversation yet.
      if (!fresh.some((i) => i.type === "owner") || !fresh.some((i) => i.type === "agent")) continue;
      const last = fresh[fresh.length - 1];
      if (last === undefined) continue;
      const quiet = this.now().getTime() - Date.parse(last.at) >= idleMs && !this.deps.working(task.id);
      if (!quiet && !this.replaced(task, chats)) continue;
      await this.read(task, fresh, last.at);
    }
  }

  /** True when the owner has written in a newer chat with the same agent. */
  private replaced(task: Task, chats: readonly Task[]): boolean {
    const { store } = this.deps;
    return chats.some(
      (other) =>
        other.id !== task.id &&
        other.team[0] === task.team[0] &&
        other.org === task.org &&
        other.createdAt > task.createdAt &&
        store.room.page(other.id, 400).items.some((i) => i.type === "owner"),
    );
  }

  private async read(task: Task, fresh: readonly RoomItem[], upTo: string): Promise<void> {
    this.reading.add(task.id);
    try {
      const projects = await this.deps.mentioned(task.id);
      await this.deps.extraction.fromChat(task, fresh, projects, () =>
        this.deps.store.chats.setExtracted(task.id, upTo),
      );
      this.failedAt.delete(task.id);
    } catch (err) {
      this.failedAt.set(task.id, this.now().getTime());
      // Nobody set a Housekeeper: nobody asked for memory, so there is nothing to say.
      if (!(err instanceof NoHousekeeper))
        console.error(`Memory from chat ${task.id} failed: ${errorMessage(err)}`);
    } finally {
      this.reading.delete(task.id);
    }
  }

  /**
   * After the agent's turn in a chat: names an untitled chat from its first exchange, and checks the
   * title once after `RETITLE_AFTER` more owner messages. Never fails the turn.
   */
  afterTurn(id: string): Promise<void> {
    return this.background.track(this.title(id));
  }

  private async title(id: string): Promise<void> {
    if (this.titling.has(id)) return;
    this.titling.add(id);
    try {
      await this.retitle(id);
    } catch (err) {
      console.error(`Titling chat ${id} failed: ${errorMessage(err)}`);
    } finally {
      this.titling.delete(id);
    }
  }

  private async retitle(id: string): Promise<void> {
    const { store } = this.deps;
    const task = store.tasks.get(id);
    if (task === undefined || !isOwnerChat(task)) return;
    const state = store.chats.get(id);
    if (state.titledBy === "owner") return;
    const items = said(store.room.page(id, 400).items);
    const owners = items.filter((i) => i.type === "owner");
    const firstOwner = owners[0];
    if (firstOwner?.type !== "owner" || !items.some((i) => i.type === "agent")) return;

    if (state.titledBy === undefined) {
      // A title that is not the default or the first line was set by the owner, before majhi kept track.
      if (!DEFAULT_CHAT_TITLES.includes(task.title) && task.title !== chatTitleFrom(firstOwner.text)) {
        store.chats.markOwnerTitled(id);
        return;
      }
      const start = items.slice(0, 2);
      const title = await this.ask(task, chatLines(start), undefined);
      this.apply(id, title?.title ?? chatTitleFrom(firstOwner.text), owners.length);
      return;
    }
    if (owners.length - state.titledOwnerMessages < RETITLE_AFTER) return;
    const recent = chatLines(items.slice(-RECENT_MESSAGES));
    const next = await this.ask(task, recent, task.title);
    // Kept, or no answer: this check is spent either way.
    this.apply(id, next === undefined || next.keep ? undefined : next.title, owners.length);
  }

  private async ask(
    task: Task,
    messages: string,
    current: string | undefined,
  ): Promise<{ title: string | undefined; keep: boolean } | undefined> {
    try {
      const { value } = await this.deps.housekeeper.ask(
        task,
        titlePrompt({ messages: messages.slice(0, TITLE_CHARS), current }),
        parseTitleReply,
      );
      return value;
    } catch (err) {
      if (!(err instanceof NoHousekeeper)) console.error(`No title for ${task.id}: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private apply(id: string, title: string | undefined, ownerMessages: number): void {
    const { store } = this.deps;
    if (store.chats.get(id).titledBy === "owner") return;
    if (title !== undefined && !this.deps.setTitle(id, title)) return;
    store.chats.setTitle(id, "auto", ownerMessages);
  }
}
