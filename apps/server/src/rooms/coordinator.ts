import { randomUUID } from "node:crypto";
import { isCaptainLane, OWNER_HANDLE, parseMentions, type RoomItem, type TaskId } from "@majhi/shared";
import { isBossChat } from "../admin/boss.ts";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import type { Crew } from "../tasks/crew-run.ts";
import type { TaskService } from "../tasks/service.ts";
import { readChoices } from "./choices.ts";
import { asksOwner, ownerQuestion } from "./owner-question.ts";

/** read_recent cuts each message to this, in the middle. */
const READ_ITEM_MAX = 1200;

export interface CoordinatorDeps {
  store: Store;
  room: RoomService;
  tasks: TaskService;
  /** The plan's steps: a finished turn is what finishes the step its agent was on. */
  crew: Pick<Crew, "turnEnded">;
  /** Whether the agent waits on a background run it started (`wait: true`): then its step waits too. */
  waitsOnProcess?: ((task: string, agent: string) => boolean) | undefined;
}

/**
 * The room (SPEC 5.3). When an agent ends a turn, its question to the owner becomes a Reply card, and the
 * step of the plan it was on is done. Nothing an agent writes wakes another agent: workers get work only
 * from the plan (`Crew`), and the owner's @mention is how an agent joins a task.
 */
export class RoomCoordinator {
  /** (task, agent) pairs that posted an ask card in the turn now running. */
  private readonly askedInTurn = new Set<string>();

  constructor(private readonly deps: CoordinatorDeps) {}

  async turnEnded(turn: { task: string; agent: string; text: string; refused?: boolean }): Promise<void> {
    const { store } = this.deps;
    const asked = this.askedInTurn.delete(`${turn.task}\u0000${turn.agent}`);
    const task = store.tasks.get(turn.task);
    if (task !== undefined && isCaptainLane(task) && task.team.includes(turn.agent)) {
      // The captain's question in its lane reaches Needs you from the end of its turn, as an owner's chat does not.
      const text = turn.text.trim();
      if (!asked && text !== "" && asksOwner(text)) this.postQuestion(task.id, turn.agent, text);
      else this.movedOn(task.id, turn.agent);
      return;
    }
    if (task === undefined || isBossChat(task)) return;
    if (task.status !== "running") {
      // In review or paused nothing moves on, but a question the agent did not ask again no
      // longer waits: a stale card would hold the ship, and the agent cannot see or answer it.
      const again = parseMentions(turn.text, []).includes(OWNER_HANDLE) || asksOwner(turn.text);
      if (!again) this.movedOn(task.id, turn.agent);
      return;
    }
    // Taken off the team: what it still says is posted, but nothing follows from it.
    if (!task.team.includes(turn.agent)) return;
    const text = turn.text.trim();
    // The agent kept working: a question it asked before and nobody answered no longer waits.
    this.movedOn(task.id, turn.agent);
    const busy = this.deps.waitsOnProcess?.(task.id, turn.agent) === true;
    const toOwner = parseMentions(text, []).includes(OWNER_HANDLE) || (text !== "" && asksOwner(text));
    const questioned = !asked && !busy && toOwner;
    if (questioned) this.postQuestion(task.id, turn.agent, text);
    // The step waits while its agent waits on the owner or on a background process, and when its model's
    // safeguards stopped it (the idle watch gives the step to another agent then).
    if (asked || questioned || busy || turn.refused === true) return;
    await this.deps.crew.turnEnded(task.id, turn.agent);
  }

  /** majhi-room `read_recent`: the last messages, newest first, each trimmed in the middle (5.13). */
  readRecent(task: string, limit: number, beforeSeq: number | undefined): string {
    this.deps.room.flush(task);
    const page = this.deps.store.room.page(task, Math.min(200, limit * 4), beforeSeq);
    const lines: string[] = [];
    let oldest: number | undefined;
    for (const item of page.items) {
      const line = readLine(item);
      if (line === undefined) continue;
      lines.push(`[${item.seq}] ${cutLine(line, item.id)}`);
      oldest = item.seq;
      if (lines.length >= limit) break;
    }
    if (lines.length === 0) return "The room has no messages yet.";
    const more =
      page.more || lines.length >= limit ? `\n\nOlder: call read_recent with before_seq ${oldest}.` : "";
    return `Room of ${task}, newest first:\n${lines.join("\n")}${more}`;
  }

  /** majhi-room `read_recent` with `item`: one message whole, a handoff with the text it carried. */
  readItem(task: string, id: string): string {
    this.deps.room.flush(task);
    const item = this.deps.store.room.get(task, id);
    if (item === undefined) throw new UserError(`The room of ${task} has no item ${id}.`, 404);
    const line =
      item.type === "handoff" ? `@${item.from} handed to @${item.to}:\n${item.text}` : readLine(item);
    if (line === undefined) throw new UserError(`Item ${id} has no message to read.`);
    return `[${item.seq}] ${line}`;
  }

  async postAskCard(
    taskId: string,
    agent: string,
    questions: Array<{
      id: string;
      question: string;
      options: Array<{ id: string; label: string }>;
      default?: string | undefined;
      freeText: boolean;
    }>,
  ): Promise<RoomItem> {
    const task = this.deps.tasks.get(taskId);
    if (!task.team.includes(agent)) {
      throw new UserError(`Agent @${agent} is not on this task.`, 409);
    }
    this.askedInTurn.add(`${task.id}\u0000${agent}`);
    const itemId = `ask:${randomUUID()}`;
    this.deps.room.post(task.id, itemId, {
      type: "ask",
      agent,
      questions,
      state: "pending",
    });
    const item = this.deps.room.get(task.id, itemId);
    if (item === undefined) throw new Error("The ask card was not stored");
    return item;
  }

  /** Reply, and a button per choice read from the message, under an agent's plain-text question. */
  private postQuestion(task: TaskId, agent: string, text: string): void {
    const question = ownerQuestion(text) ?? firstLine(text);
    this.deps.room.post(task, `question:${randomUUID()}`, {
      type: "owner-question",
      agent,
      text: question.slice(0, 600),
      // Merging, shipping and asking for changes live on the review card; no second set of buttons.
      choices: readChoices(text).filter((c) => !REVIEW_CARD_CHOICE.test(c)),
      state: "pending",
    });
  }

  /**
   * Once at startup: unanswered plain-text questions that kept neither the question nor choices
   * (made before cards stored their text) show as an empty Reply and can only mislead. They stop
   * waiting.
   */
  sweepEmptyQuestions(): number {
    let swept = 0;
    for (const t of this.deps.store.tasks.list(false)) {
      for (const q of this.deps.store.room.pendingOfType(t.id, "owner-question")) {
        if (q.type !== "owner-question" || q.choices.length > 0 || (q.text ?? "").trim() !== "") continue;
        this.deps.room.post(t.id as TaskId, q.id, { ...q, state: "moved-on" });
        swept += 1;
      }
    }
    return swept;
  }

  /** This agent's unanswered plain-text questions stop waiting: it went on without an answer. */
  private movedOn(task: TaskId, agent: string): void {
    this.deps.room.flush(task);
    for (const q of this.deps.store.room.pendingOfType(task, "owner-question")) {
      if (q.type !== "owner-question" || q.agent !== agent) continue;
      this.deps.room.post(task, q.id, { ...q, state: "moved-on" });
    }
  }
}

/** A long read_recent line cut in the middle, with a marker that says how to read it whole. */
function cutLine(line: string, id: string): string {
  if (line.length <= READ_ITEM_MAX) return line;
  const marker = `\n[... cut; read_recent with item "${id}" reads it whole ...]\n`;
  const head = Math.ceil(READ_ITEM_MAX / 2);
  return `${line.slice(0, head)}${marker}${line.slice(line.length - (READ_ITEM_MAX - head))}`;
}

/** A message in the room for read_recent, or undefined for items that are not conversation. */
export function readLine(item: RoomItem): string | undefined {
  switch (item.type) {
    case "owner":
      return `Owner${item.to === undefined ? "" : ` to @${item.to}`}: ${item.text}`;
    case "agent":
      return item.text.trim() === "" ? undefined : `@${item.agent}: ${item.text}`;
    case "handoff":
      return `@${item.from} handed to @${item.to}`;
    case "diagram":
      return `@${item.agent} drew a diagram: ${item.spec.title}`;
    case "team-plan":
      return `@${item.agent} recorded plan v${item.version}: ${item.steps.map((s, i) => `${i + 1}. ${s.who} ${s.what}${s.status === undefined || s.status === "todo" ? "" : ` (${s.status}${s.result === undefined ? "" : `: ${s.result}`})`}`).join(" ")} Why: ${item.why}`;
    case "system":
      return `majhi: ${item.text}`;
    case "approval":
      return `@${item.agent} asked to run ${item.command}: ${item.state}`;
    // A card that still waits for the owner: agents see what holds the task. Settled ones say nothing.
    case "owner-question":
      return item.state === "pending"
        ? `@${item.agent} asked the owner (card waits for an answer): ${item.text ?? ""}`.trimEnd()
        : undefined;
    case "ask":
      return item.state === "pending"
        ? `@${item.agent} asked the owner (card waits for an answer): ${item.questions.map((q) => q.question).join(" | ")}`
        : undefined;
    default:
      return undefined;
  }
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? text;
  return line.length > 200 ? `${line.slice(0, 199)}...` : line;
}

/** Choices the review card already offers (Ship, Mark done, Ask for changes). */
const REVIEW_CARD_CHOICE =
  /\b(merge|ship|push|mark (it |the task )?done|ask for changes|request changes|review)\b/i;
