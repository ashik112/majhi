import { randomUUID } from "node:crypto";
import type { RoomItem, Task, TaskId, TaskStatus } from "@majhi/shared";
import { isBossChat } from "../admin/boss.ts";
import { errorMessage } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { Store } from "../store/index.ts";
import { ancestorsOf } from "../tasks/planner.ts";

/** How long after a turn ends the room is looked at: a handoff about to fire is not woken twice. */
export const IDLE_CHECK_MS = 5_000;

/** Room items that wait for the owner's answer. While one is pending, the owner has the next move. */
const OWNER_CARDS: readonly RoomItem["type"][] = [
  "ask",
  "choice",
  "approval",
  "permission",
  "owner-question",
  "secret-request",
];

/** What the room looks like a moment after a turn ended. */
export interface RoomFacts {
  status: TaskStatus;
  /** Agents of the task queued, starting or in a turn. */
  working: number;
  ownerCard: boolean;
  /** An agent waits on a background process it started with `wait`. */
  process: boolean;
  /** A subtask runs, is in review or paused for the owner, or starts by itself when it can. */
  childMoves: boolean;
}

/** Nobody works on a running task and nothing will wake anyone: a handoff got lost. */
export function stalled(f: RoomFacts): boolean {
  return f.status === "running" && f.working === 0 && !f.ownerCard && !f.process && !f.childMoves;
}

/**
 * Whether a subtask moves on without the lead: it runs, waits in review or paused for the owner,
 * or starts by itself when its dependencies are met. One that waits for its own ancestor never
 * starts while that ancestor runs, so it does not count.
 */
export function childMoves(child: {
  status: TaskStatus;
  startWhenReady: boolean;
  waitsOnAncestor: boolean;
}): boolean {
  if (child.status === "running" || child.status === "review" || child.status === "paused") return true;
  if (child.status === "done") return false;
  return child.startWhenReady && !child.waitsOnAncestor;
}

/** The last non-empty line of a message, trimmed, for a one-line quote. */
export function lastLine(text: string, max = 200): string {
  const line =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .at(-1) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * How a turn ended: by itself, stopped by the model's safeguards, failed with an error, or failed
 * because the agent's account needs a new sign-in.
 */
export type TurnEnding = "finished" | "refused" | "failed" | "signed-out";

/**
 * The note that wakes the lead when a teammate ended its turn and nobody took over. `refused`: the
 * model's safeguards stopped the teammate, so its step needs someone else or other words. `failed`:
 * its turn failed. `signed-out`: its account needs a new sign-in, so its step needs someone else.
 */
export function leadNote(
  task: string,
  finished: string,
  text: string,
  ending: TurnEnding | boolean = "finished",
  account?: string,
): string {
  const how: TurnEnding = ending === true ? "refused" : ending === false ? "finished" : ending;
  const quote = lastLine(text);
  const last = quote === "" ? "." : `. Its last line: "${quote}"`;
  if (how === "signed-out") {
    return [
      `@${finished} cannot run: its account ${account ?? "its account"} needs a new sign-in, so the step you gave it did not start. Nobody is working on ${task} now.`,
      "Nothing else is pending: no handoff, no question to the owner, no background process.",
      `Give its step to a teammate whose account works (the majhi-room mention tool, or "@name: please ..."). Do not hand anything to @${finished} until the owner signs it in again.`,
    ].join("\n");
  }
  if (how === "failed") {
    return [
      `@${finished}'s turn failed with an error: "${quote === "" ? "unknown error" : quote}". Nobody is working on ${task} now.`,
      "Nothing else is pending: no handoff, no question to the owner, no background process.",
      'Hand its step back to it if the error looks passing, give it to another teammate (the majhi-room mention tool, or "@name: please ..."), or say what it waits for.',
    ].join("\n");
  }
  if (how === "refused") {
    return [
      `@${finished} was blocked by its model's safeguards and stopped. Nobody is working on ${task} now${last}`,
      "Nothing else is pending: no handoff, no question to the owner, no background process.",
      'Give its step to another teammate (the majhi-room mention tool, or "@name: please ..."), or rephrase the step and hand it back to it. Do not repeat the same words.',
    ].join("\n");
  }
  return [
    `@${finished} finished its turn and nobody is working on ${task} now${last}`,
    "Nothing is pending: no handoff, no question to the owner, no background process.",
    'Hand off the next step of your plan (the majhi-room mention tool, or "@name: please ..."), finish the task, or say what it waits for.',
  ].join("\n");
}

/** The line the owner sees when the lead itself ended and nobody else is left to wake. */
export function ownerLine(
  task: string,
  lead: string,
  text: string,
  ending: TurnEnding | boolean = "finished",
): string {
  const how: TurnEnding = ending === true ? "refused" : ending === false ? "finished" : ending;
  const quote = lastLine(text);
  if (how === "refused") {
    return `@${lead} was blocked by its model's safeguards and nobody is working on ${task}. Rephrase the step, change its model, or give the step to another agent.`;
  }
  if (how === "failed" || how === "signed-out") {
    return `Nobody is working on ${task}: @${lead}'s last turn failed${quote === "" ? "" : ` with "${quote}"`}. Resume the task to try again, or give the step to another agent.`;
  }
  return `Nobody is working on ${task} and nothing is pending. @${lead}'s last message: ${quote === "" ? "(empty)" : `"${quote}"`}`;
}

/**
 * The owner's line when the lead ended its turn after a teammate's turn failed and nobody picked the
 * step up: names the failure, not "nothing is pending".
 */
export function failedTeammateLine(task: string, lead: string, failed: Failure): string {
  const quote = lastLine(failed.text);
  const cause =
    failed.ending === "signed-out"
      ? `@${failed.agent} cannot run: its account ${failed.account ?? ""} needs a new sign-in`.replace(
          / {2,}/g,
          " ",
        )
      : `@${failed.agent}'s last turn failed${quote === "" ? "" : ` with "${quote}"`}`;
  return `Nobody is working on ${task}: ${cause}, and @${lead} handed its step to nobody else. Give the step to another agent, or sign the account in and resume.`;
}

/** A teammate's turn that failed, until someone works again. */
interface Failure {
  agent: string;
  text: string;
  ending: "failed" | "signed-out";
  account?: string | undefined;
}

export interface IdleWatchDeps {
  store: Store;
  room: RoomService;
  runs: {
    working(task: string): string[];
    /** Something of the task's agents is on its way (queued for a slot, starting, held by a gate). */
    busy?(task: string): boolean;
    notify(task: string, agent: string, text: string): void;
  };
  /** Pauses the task for the owner with this line in the room ("needs you"). */
  pauseForOwner: (task: string, text: string) => Promise<void>;
  /** Whether an agent of the task waits on a background process it started. */
  waitsOnProcess: (task: string) => boolean;
  delayMs?: number | undefined;
}

/**
 * Keeps a running task from going silent (5.3). A moment after an agent ends a turn with nothing
 * queued (by itself, or stopped by its model's safeguards with no other model left to try), when the task still runs but nobody works, no owner card waits and no background process
 * is waited on, the lead is woken once with who finished last. When the lead itself ended, the owner
 * is asked instead: the task pauses as blocked. At most once per quiet period: every turn that ends
 * starts a new one. Lives in memory: after a restart the resilience sweep wakes stranded tasks, and
 * the next turn that ends arms this again.
 */
export class IdleWatch {
  private readonly last = new Map<
    string,
    { agent: string; text: string; ending: TurnEnding; account?: string | undefined; turn: number }
  >();
  /** Per task, the last teammate turn that failed and that the lead was told of, until a turn ends well. */
  private readonly failed = new Map<string, Failure>();
  /** The turn each task's quiet period was handled for. */
  private readonly handled = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private turns = 0;

  constructor(private readonly deps: IdleWatchDeps) {}

  /** An agent ended a turn with this final message. `refused`: the model's safeguards ended it. */
  turnEnded(turn: { task: string; agent: string; text: string; refused?: boolean }): void {
    this.turns += 1;
    this.last.set(turn.task, {
      agent: turn.agent,
      text: turn.text,
      ending: turn.refused === true ? "refused" : "finished",
      turn: this.turns,
    });
    // The failed teammate works again: its failure is over.
    if (this.failed.get(turn.task)?.agent === turn.agent) this.failed.delete(turn.task);
  }

  /**
   * An agent's turn failed and nothing is queued after it: `signed-out` when its account needs a new
   * sign-in, `error` otherwise. Looked at in a moment, like a turn that ended.
   */
  turnFailed(turn: {
    task: string;
    agent: string;
    text: string;
    cause: "signed-out" | "error";
    account?: string | undefined;
  }): void {
    this.turns += 1;
    this.last.set(turn.task, {
      agent: turn.agent,
      text: turn.text,
      ending: turn.cause === "signed-out" ? "signed-out" : "failed",
      account: turn.account,
      turn: this.turns,
    });
    this.idle(turn.task);
  }

  /** An agent of the task has nothing queued: look at the room in a moment. */
  idle(task: string): void {
    const old = this.timers.get(task);
    if (old !== undefined) clearTimeout(old);
    const timer = setTimeout(() => {
      this.timers.delete(task);
      void this.check(task).catch((err: unknown) =>
        console.error(`Idle check of ${task} failed: ${errorMessage(err)}`),
      );
    }, this.deps.delayMs ?? IDLE_CHECK_MS);
    timer.unref();
    this.timers.set(task, timer);
  }

  async check(id: string): Promise<void> {
    const { store, runs } = this.deps;
    const last = this.last.get(id);
    const task = store.tasks.get(id);
    if (task === undefined || task.status !== "running" || isBossChat(task)) {
      this.last.delete(id);
      this.handled.delete(id);
      this.failed.delete(id);
      return;
    }
    if (last === undefined || this.handled.get(id) === last.turn) return;
    const lead = task.team[0];
    if (lead === undefined) return;
    // A teammate that cannot sign in can do nothing more: the lead hears it now, busy or not, once.
    const signedOut = last.ending === "signed-out" && last.agent !== lead;
    if (!signedOut && !stalled(this.facts(task, runs.working(id).length))) return;
    this.handled.set(id, last.turn);
    if (last.agent !== lead) {
      if (last.ending === "failed" || last.ending === "signed-out") {
        this.failed.set(id, {
          agent: last.agent,
          text: last.text,
          ending: last.ending,
          account: last.account,
        });
      }
      const what =
        last.ending === "refused"
          ? "was blocked by its model's safeguards"
          : last.ending === "signed-out"
            ? `could not run (its account ${last.account ?? ""} needs a new sign-in)`.replace(/ {2,}/g, " ")
            : last.ending === "failed"
              ? "failed"
              : "finished";
      const woke = signedOut
        ? `@${last.agent} ${what}. Woke @${lead} to give its step to a teammate.`
        : `Nobody was working on ${task.id} after @${last.agent} ${what}. Woke @${lead}.`;
      this.say(task.id, woke);
      runs.notify(task.id, lead, leadNote(task.id, last.agent, last.text, last.ending, last.account));
      return;
    }
    // The lead ended too. A teammate's failure it was told of and left is the cause, not "nothing".
    const failed = last.ending === "finished" ? this.failed.get(id) : undefined;
    this.failed.delete(id);
    await this.deps.pauseForOwner(
      task.id,
      failed === undefined
        ? ownerLine(task.id, lead, last.text, last.ending)
        : failedTeammateLine(task.id, lead, failed),
    );
  }

  /**
   * Whether a running task is quiet right now: nobody works, waits for a slot or starts, no owner
   * card waits, no background process is waited on and no subtask moves.
   */
  quiet(id: string): boolean {
    const task = this.deps.store.tasks.get(id);
    if (task === undefined || task.status !== "running" || isBossChat(task)) return false;
    const busy = this.deps.runs.busy?.(id) ?? this.deps.runs.working(id).length > 0;
    return stalled(this.facts(task, busy ? 1 : 0));
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private facts(task: Task, working: number): RoomFacts {
    const { store, room } = this.deps;
    room.flush(task.id);
    const get = (id: string) => store.tasks.get(id);
    return {
      status: task.status,
      working,
      ownerCard: OWNER_CARDS.some((type) => store.room.pendingOfType(task.id, type).length > 0),
      process: this.deps.waitsOnProcess(task.id),
      childMoves: store.tasks.children(task.id).some((id) => {
        const child = get(id);
        if (child === undefined) return false;
        const ancestors = ancestorsOf(child, get);
        return childMoves({
          status: child.status,
          startWhenReady: store.tasks.startWhenReady(id),
          waitsOnAncestor: store.tasks.unmetDependencies(id).some((d) => ancestors.has(d)),
        });
      }),
    };
  }

  private say(task: TaskId, text: string): void {
    this.deps.room.post(task, `info:${randomUUID()}`, { type: "system", level: "info", text });
  }
}
