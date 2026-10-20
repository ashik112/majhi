import type { Conversation, RoomItem } from "@majhi/shared";
import type { EventHub } from "../events/hub.ts";
import type { Store } from "../store/index.ts";

/** A burst of messages in one conversation (a streamed reply saves about once a second) sends one event. */
const SETTLE_MS = 150;

/**
 * The chat dock's server side: the list, the owner's read marks, and the one event that keeps every
 * tab's list current. A conversation changes when an agent or the owner writes a message, or when the
 * owner reads; each sends that conversation's row as it is now, so tabs patch instead of reading the list.
 */
export class ConversationsService {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: {
      store: Pick<Store, "conversations">;
      events: Pick<EventHub, "send">;
      /** The id of the owner's current Captain chat (the one the bubble opens), when there is one. */
      currentChat?: () => string | undefined;
      /** The current Captain chat may have changed: forget what was remembered of it. */
      forgetCurrent?: () => void;
    },
  ) {}

  list(): Conversation[] {
    const current = this.deps.currentChat?.();
    const all = this.deps.store.conversations.list();
    const lanes = all.filter((c) => c.kind === "captain");
    return all
      .filter((c) => c.kind !== "captain")
      .map((c) => (c.id === current ? this.fold(this.mark(c, current), lanes) : c));
  }

  /** Flags the current Captain chat. Every other root Captain chat is an older one. */
  private mark(conversation: Conversation, current: string | undefined): Conversation {
    return conversation.id === current ? { ...conversation, current: true } : conversation;
  }

  /**
   * The workspaces' captain steps are not conversations of their own: the owner has one. Their unread
   * messages and newest line count for the Captain chat.
   */
  private fold(desk: Conversation, lanes: readonly Conversation[]): Conversation {
    const unread = lanes.reduce((sum, l) => sum + l.unread, desk.unread);
    const newest = lanes.reduce<Conversation | undefined>(
      (best, l) => (l.lastAt > (best?.lastAt ?? desk.lastAt) ? l : best),
      undefined,
    );
    return {
      ...desk,
      unread,
      ...(newest === undefined ? {} : { lastLine: newest.lastLine, lastAt: newest.lastAt }),
    };
  }

  /** The conversations whose messages hold the words. A hit in a workspace's step is a hit in the Captain chat. */
  search(query: string): string[] {
    const desk = this.deps.currentChat?.();
    const found = this.deps.store.conversations.matching(query);
    const lanes = new Set(
      this.deps.store.conversations
        .list()
        .filter((c) => c.kind === "captain")
        .map((c) => c.id),
    );
    return [...new Set(found.map((id) => (lanes.has(id) && desk !== undefined ? desk : id)))];
  }

  /** Marks read and tells every tab. False when the id is not a conversation of the dock. */
  markRead(id: string, upTo: string): boolean {
    const known = this.deps.store.conversations.markRead(id, upTo);
    if (known && id === this.deps.currentChat?.()) {
      // Reading the Captain chat reads the workspaces' steps in it.
      for (const lane of this.deps.store.conversations.list().filter((c) => c.kind === "captain")) {
        this.deps.store.conversations.markRead(lane.id, upTo);
      }
    }
    if (known) this.announce(id);
    return known;
  }

  /** Hides or restores a conversation and tells every tab. False when the id is not listed. */
  archive(id: string, archived: boolean): boolean {
    const known = this.deps.store.conversations.archive(id, archived);
    if (known) this.announce(id);
    return known;
  }

  /** A room item was stored. Only messages change a row. */
  observe(task: string, item: RoomItem): void {
    if (
      item.type !== "agent" &&
      item.type !== "owner" &&
      item.type !== "client" &&
      item.type !== "client-reply"
    )
      return;
    if (this.pending.has(task)) return;
    const timer = setTimeout(() => {
      this.pending.delete(task);
      this.announce(task);
    }, SETTLE_MS);
    timer.unref();
    this.pending.set(task, timer);
  }

  stop(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /** Sends a conversation's row as it is now to every tab. */
  changed(id: string): void {
    this.deps.forgetCurrent?.();
    this.announce(id);
  }

  private announce(id: string): void {
    const current = this.deps.currentChat?.();
    const conversation = this.deps.store.conversations.one(id);
    // A change in a workspace's step is a change of the Captain chat's row.
    if (conversation?.kind === "captain" && current !== undefined) {
      this.announce(current);
      return;
    }
    const row =
      conversation === undefined
        ? undefined
        : id === current
          ? this.fold(
              this.mark(conversation, current),
              this.deps.store.conversations.list().filter((c) => c.kind === "captain"),
            )
          : conversation;
    this.deps.events.send({ type: "conversation", id, ...(row === undefined ? {} : { conversation: row }) });
  }
}
