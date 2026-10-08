import type {
  ChatHistoryInput,
  ChatHistoryResult,
  ChatOpenIncidentInput,
  ChatStartTaskInput,
  ClientOutcome,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { FindingsService } from "../findings/service.ts";
import type { RoomService } from "../room/service.ts";
import type { RoomRow } from "../store/client.ts";
import type { Store } from "../store/index.ts";
import type { ChatHistory } from "./history.ts";
import type { ClientIncidents } from "./incidents.ts";
import { markWorking, workingItems, writeOutcome } from "./outcome.ts";
import { type ClientItem, clip, peopleLine, readable } from "./read.ts";
import type { ReplyResult } from "./replies.ts";
import type { ChatWork } from "./work.ts";

/** A reply this soon after the captain opened an incident or a task for a message is part of how it dealt with it. */
const ANSWER_WINDOW_MS = 30 * 60_000;

export interface CaptainChatDeps {
  store: Store;
  room: Pick<RoomService, "post">;
  incidents: Pick<ClientIncidents, "openFor" | "statuses" | "replied">;
  work: Pick<ChatWork, "begin">;
  findings: Pick<FindingsService, "dismiss">;
  history?: ChatHistory | undefined;
  changed: () => void;
}

/**
 * What the captain's client-chat tools do beyond the rails they call. Each one acts through an existing service and
 * writes what it did onto the client message it answers, so the line under a message is what the captain did.
 */
export class CaptainChat {
  constructor(private readonly deps: CaptainChatDeps) {}

  /** The message a tool is about: the one named, else the newest still waiting for the captain, else the newest. */
  private target(room: RoomRow, id: string | undefined): ClientItem {
    const { store } = this.deps;
    if (id !== undefined) {
      const found = store.room.get(room.id, id);
      if (found?.type === "client") return found;
      throw new UserError(`There is no message ${id} in this chat.`, 404);
    }
    const waiting = workingItems(store, room.id).at(-1);
    const newest = store.room
      .page(room.id, 60)
      .items.filter((i): i is ClientItem => i.type === "client" && i.us !== true)
      .at(-1);
    const item = waiting ?? newest;
    if (item === undefined) throw new UserError("This chat has no client message yet.", 409);
    return item;
  }

  /** What an outcome is written on: the message named, else the batch still waiting, else the newest message. */
  private scope(room: RoomRow, named: string | undefined, item: ClientItem): string | undefined {
    if (named !== undefined) return named;
    return workingItems(this.deps.store, room.id).length > 0 ? undefined : item.id;
  }

  history(room: RoomRow, input: ChatHistoryInput): Promise<ChatHistoryResult> {
    return this.read(room, input.limit ?? 30);
  }

  private async read(room: RoomRow, limit: number): Promise<ChatHistoryResult> {
    const messages: ChatHistoryResult["messages"] = [];
    for (const item of this.deps.store.room.page(room.id, limit * 2).items.toReversed()) {
      if (item.type === "client") {
        const outcome = item.outcome;
        messages.push({
          id: item.id,
          from: item.us === true ? "team" : "client",
          name: item.sender.name,
          text: readable(room, item).slice(0, 1500),
          at: item.sentAt ?? item.at,
          ...(item.us === true ? {} : { to: item.sender.id, replyTo: item.external.message }),
          ...(outcome === undefined
            ? {}
            : {
                outcome: `${outcome.state}${outcome.why === undefined ? "" : `: ${clip(outcome.why, 120)}`}`,
              }),
        });
      } else if (item.type === "client-reply" && item.state === "sent") {
        messages.push({
          id: item.id,
          from: "team",
          name: "Team",
          text: item.text.slice(0, 1500),
          at: item.at,
        });
      }
    }
    return {
      title: room.chat.title,
      people: peopleLine(this.deps.store, room),
      messages: messages.toSorted((a, b) => a.at.localeCompare(b.at)).slice(-limit),
      incidents: await this.deps.incidents.statuses(room.id),
    };
  }

  async openIncident(
    room: RoomRow,
    input: ChatOpenIncidentInput,
  ): Promise<{ task: string; joined: boolean }> {
    const org = room.org as string;
    const item = this.target(room, input.item);
    const made = await this.deps.incidents.openFor(room, item, input.found);
    const outcome: ClientOutcome = {
      state: "handled",
      why: `${made.reopened ? "Reopened" : made.joined ? "Joined" : "Opened"} incident ${made.task}`,
      task: made.task,
    };
    const marked = markWorking(this.deps, room.id, outcome, this.scope(room, input.item, item));
    for (const m of marked) this.close(m.outcome?.finding, made.task, org);
    this.deps.history?.({
      text: `${made.reopened ? "Reopened" : made.joined ? "Joined" : "Opened"} incident ${made.task} for ${room.chat.title}`,
      org,
      task: made.task,
    });
    this.deps.changed();
    return { task: made.task, joined: made.joined };
  }

  async startTask(room: RoomRow, input: ChatStartTaskInput): Promise<{ task: string; started: boolean }> {
    const item = this.target(room, input.item);
    const made = await this.deps.work.begin(
      room,
      item,
      item.outcome?.finding,
      input.text,
      input.readOnly === true,
    );
    markWorking(
      this.deps,
      room.id,
      {
        state: "handled",
        why: made.started ? `Started task ${made.task}` : `Made task ${made.task}, it waits for Start`,
        task: made.task,
      },
      this.scope(room, input.item, item),
    );
    this.deps.changed();
    return made;
  }

  /**
   * The owner opens a task from one message of the room. A captain reply stands for the client message it answers.
   * The message must be in this room: an id of another room's message is not found here. The task goes through
   * the same start path as the captain's own (`startTask`), so its origin, workspace and outcome line are the same.
   */
  async makeTask(room: RoomRow, itemId: string): Promise<{ task: string; started: boolean }> {
    if (room.org === undefined) throw new UserError("Link the chat to a workspace first.", 409);
    const found = this.deps.store.room.get(room.id, itemId);
    let message: ClientItem | undefined;
    if (found?.type === "client") message = found;
    else if (found?.type === "client-reply") message = this.answered(room, found);
    if (message === undefined) throw new UserError(`There is no message ${itemId} in this chat to make a task from.`, 404);
    if (message.us === true) throw new UserError("That message is from your team, not a client.", 409);
    const said = readable(room, message).trim();
    return this.startTask(room, {
      room: room.id,
      item: message.id,
      text: said === "" ? `${message.sender.name} sent a file` : said.slice(0, 3000),
    });
  }

  /** The client message a reply answers: the one it names, else the newest client message before it. */
  private answered(room: RoomRow, reply: { replyTo?: string | undefined; seq: number }): ClientItem | undefined {
    const clients = this.deps.store.room
      .page(room.id, 200)
      .items.filter((i): i is ClientItem => i.type === "client" && i.us !== true);
    const named = reply.replyTo === undefined ? undefined : clients.find((c) => c.external.message === reply.replyTo);
    return named ?? clients.filter((c) => c.seq < reply.seq).toSorted((a, b) => b.seq - a.seq)[0];
  }

  /** The captain's reply went through the rails: it is what became of the messages it answered. */
  replied(room: RoomRow, sent: ReplyResult): void {
    const outcome: ClientOutcome = {
      state: sent.state === "sent" ? "replied" : sent.state === "held" ? "waits" : "failed",
      ...(sent.state === "sent" ? { why: "Captain replied" } : {}),
      draft: sent.draft,
    };
    const marked = markWorking(this.deps, room.id, outcome);
    for (const m of marked) this.close(m.outcome?.finding, "reply", room.org as string);
    // A message the captain opened an incident or a task for, and then answered: one line says both.
    const since = Date.now() - ANSWER_WINDOW_MS;
    for (const m of this.deps.store.room.page(room.id, 40).items) {
      if (m.type !== "client" || m.us === true) continue;
      const out = m.outcome;
      if (out?.state !== "handled" || out.task === undefined || out.draft !== undefined) continue;
      if (Date.parse(m.sentAt ?? m.at) < since) continue;
      writeOutcome(this.deps, room.id, m, {
        ...outcome,
        why: `${out.why ?? "Handled"}${sent.state === "sent" ? ", told the client" : ""}`,
        task: out.task,
        ...(out.finding === undefined ? {} : { finding: out.finding }),
      });
      marked.push(m);
    }
    this.deps.incidents.replied(room.id, sent.draft);
    if (marked.length > 0) this.deps.changed();
  }

  private close(finding: number | undefined, what: string, org: string): void {
    if (finding === undefined) return;
    try {
      this.deps.findings.dismiss(
        finding,
        what === "reply" ? "The captain replied" : `Joined incident ${what}`,
        {
          kind: "captain",
          org,
        },
      );
    } catch {
      // Closed already, or taken up by a task.
    }
  }
}
