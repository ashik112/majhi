import { chatWaitDecisionId, type OwnerDecision, type RoomItem, type TaskId } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { FindingsService } from "../findings/service.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import type { ChatHistory } from "./history.ts";
import { writeOutcome } from "./outcome.ts";

type ClientItem = Extract<RoomItem, { type: "client" }>;

export interface WaitsDeps {
  store: Store;
  room: Pick<RoomService, "get" | "post">;
  findings: Pick<FindingsService, "dismiss">;
  /** The owner's answer to "who is this?". */
  whoIs: (room: string, card: string, answer: "us" | "client") => Promise<void>;
  history?: ChatHistory | undefined;
  changed: () => void;
  now?: () => Date;
}

/** How far back a message that waits still counts. */
const WINDOW_MS = 14 * 86_400_000;
const SCAN = 80;

function clip(text: string, max: number): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What waits for the owner in client chats, derived from the messages themselves: a message whose outcome is
 * "waits" with no reply held for it. Nothing is stored twice. The decision goes when the message is dealt with: the
 * owner answers it here, or writes in the chat after it.
 */
export class ChatWaits {
  constructor(private readonly deps: WaitsDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The waiting messages of one room, oldest first: those still open, and those a person answered by writing in the
   * chat after them (the owner's reply, or a teammate's message). The captain's own replies answer nothing.
   */
  private scan(room: RoomRow): { open: ClientItem[]; answered: ClientItem[] } {
    const since = new Date(this.now().getTime() - WINDOW_MS).toISOString();
    const open: ClientItem[] = [];
    const answered: ClientItem[] = [];
    let covered = false;
    for (const item of this.deps.store.room.page(room.id, SCAN).items) {
      if (item.type === "client-reply" && item.state === "sent" && item.by === "you") covered = true;
      if (item.type === "client" && item.us === true) covered = true;
      if (item.type !== "client" || item.deleted === true || item.us === true) continue;
      if (item.outcome?.state !== "waits" || item.outcome.draft !== undefined) continue;
      if (covered) answered.push(item);
      else if ((item.sentAt ?? item.at) >= since) open.push(item);
    }
    return { open: open.reverse(), answered };
  }

  private rooms(): RoomRow[] {
    return this.deps.store.client
      .rooms()
      .filter((r) => r.org !== undefined && r.chat.archived !== true && r.chat.ignored !== true);
  }

  decisions(): OwnerDecision[] {
    const out: OwnerDecision[] = [];
    for (const room of this.rooms()) {
      const org = room.org as string;
      const seenWho = new Set<string>();
      const plain: ClientItem[] = [];
      for (const item of this.scan(room).open) {
        const card = this.deps.room.get(room.id, `who:${item.sender.id}`);
        if (card?.type === "who-is" && card.state === "asking") {
          if (seenWho.has(card.sender)) continue;
          seenWho.add(card.sender);
          out.push({
            id: chatWaitDecisionId(room.id, card.id),
            kind: "reply",
            org,
            title: `Is ${card.name} one of us? In ${room.chat.title}`,
            sentence: `${card.name} wrote in ${room.chat.title}. Until you say who they are, the captain does not read it.`,
            options: [
              { id: "client", label: "A client", primary: true },
              { id: "us", label: "One of us" },
            ],
            at: item.at,
            link: { kind: "chat", id: room.id as TaskId },
          });
        } else plain.push(item);
      }
      for (const item of plain) {
        // A message held for a decision of its own (who pays for the captain) is that decision's, not a second card.
        if (item.outcome?.decision !== undefined) continue;
        out.push({
          id: chatWaitDecisionId(room.id, item.id),
          kind: "reply",
          org,
          title: `${item.sender.name} in ${room.chat.title}: ${clip(item.text, 90)}`,
          sentence: `${item.sender.name} in ${room.chat.title} wrote: "${clip(item.text, 160)}". ${item.outcome?.why ?? "It waits for you."}`,
          options: [{ id: "handled", label: "Handled", primary: true }],
          at: item.at,
          link: { kind: "chat", id: room.id as TaskId },
        });
      }
    }
    return out;
  }

  /** Closes the finding of every message a person already answered in the chat. Run on each pass. */
  settle(): void {
    for (const room of this.rooms()) {
      for (const item of this.scan(room).answered) this.close(room, item, "Answered in the chat");
    }
  }

  private close(room: RoomRow, item: ClientItem, why: string): void {
    const { finding } = item.outcome ?? {};
    writeOutcome(this.deps, room.id, item, {
      state: "handled",
      why,
      ...(finding === undefined ? {} : { finding }),
    });
    if (finding === undefined) return;
    try {
      this.deps.findings.dismiss(finding, why, { kind: "owner" });
    } catch {
      // Closed already.
    }
  }

  async answer(roomId: string, ref: string, option: string): Promise<void> {
    const room = this.deps.store.client.room(roomId);
    if (room === undefined || room.org === undefined) throw new UserError("That chat is gone.", 404);
    if (ref.startsWith("who:")) {
      if (option !== "us" && option !== "client") throw new UserError("Pick one of the buttons.", 400);
      await this.deps.whoIs(roomId, ref, option);
      return;
    }
    const found = this.deps.room.get(roomId, ref);
    if (found?.type !== "client") throw new UserError("That message is gone.", 409);
    this.close(room, found, option === "dismiss" ? "You said it is not an outage" : "You handled it");
    this.deps.changed();
  }
}
