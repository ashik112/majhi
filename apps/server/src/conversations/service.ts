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
    },
  ) {}

  list(): Conversation[] {
    return this.deps.store.conversations.list();
  }

  /** Marks read and tells every tab. False when the id is not a conversation of the dock. */
  markRead(id: string, upTo: string): boolean {
    const known = this.deps.store.conversations.markRead(id, upTo);
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

  private announce(id: string): void {
    const conversation = this.deps.store.conversations.one(id);
    this.deps.events.send({
      type: "conversation",
      id,
      ...(conversation === undefined ? {} : { conversation }),
    });
  }
}
