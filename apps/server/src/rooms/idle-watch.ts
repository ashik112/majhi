import type { RoomItem, Task, TaskStatus } from "@majhi/shared";
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

/** How a turn ended: by itself, stopped by the model's safeguards, or failed with an error. */
export type TurnEnding = "finished" | "refused" | "failed";

/** The line the owner sees when nobody is left to carry on and the plan has nowhere to hand the step. */
export function ownerLine(task: string, agent: string, text: string, ending: TurnEnding): string {
  const quote = lastLine(text);
  if (ending === "refused") {
    return `@${agent} was blocked by its model's safeguards and nobody is working on ${task}. Rephrase the step, change its model, or give the step to another agent.`;
  }
  if (ending === "failed") {
    return `Nobody is working on ${task}: @${agent}'s last turn failed${quote === "" ? "" : ` with "${quote}"`}. Resume the task to try again, or give the step to another agent.`;
  }
  return `Nobody is working on ${task} and nothing is pending. @${agent}'s last message: ${quote === "" ? "(empty)" : `"${quote}"`}`;
}

export interface IdleWatchDeps {
  store: Store;
  room: RoomService;
  runs: {
    working(task: string): string[];
    /** Something of the task's agents is on its way (queued for a slot, starting, held by a gate). */
    busy?(task: string): boolean;
  };
  /** The plan's side: put an unfinished step back to work, or give an agent's step to another agent. */
  crew: {
    kick(task: string): Promise<boolean>;
    stuck(
      task: string,
      agent: string,
      ending: Exclude<TurnEnding, "finished">,
      text: string,
    ): Promise<boolean>;
  };
  /** Pauses the task for the owner with this line in the room ("needs you"). */
  pauseForOwner: (task: string, text: string) => Promise<void>;
  /** Whether an agent of the task waits on a background process it started. */
  waitsOnProcess: (task: string) => boolean;
  delayMs?: number | undefined;
}

/**
 * Keeps a running task from going silent (5.3). A moment after an agent ends a turn with nothing
 * queued (by itself, stopped by its model's safeguards with no other model left to try, or failed),
 * when the task still runs but nobody works, no owner card waits and no background process is waited
 * on: a plan with a step left is put back to work (the step goes to another agent when its owner
 * failed or was blocked), and a task with no plan, or nowhere to hand the step, goes to the owner as
 * paused. At most once per quiet period: every turn that ends starts a new one. Lives in memory:
 * after a restart the resilience sweep wakes stranded tasks, and the next turn that ends arms this again.
 */
export class IdleWatch {
  private readonly last = new Map<
    string,
    { agent: string; text: string; ending: TurnEnding; turn: number }
  >();
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
  }

  /** An agent's turn failed with an error and nothing is queued after it. Looked at in a moment, like a turn that ended. */
  turnFailed(turn: { task: string; agent: string; text: string }): void {
    this.turns += 1;
    this.last.set(turn.task, { agent: turn.agent, text: turn.text, ending: "failed", turn: this.turns });
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
    const { store, runs, crew } = this.deps;
    const last = this.last.get(id);
    const task = store.tasks.get(id);
    if (task === undefined || task.status !== "running" || isBossChat(task)) {
      this.last.delete(id);
      this.handled.delete(id);
      return;
    }
    if (last === undefined || this.handled.get(id) === last.turn) return;
    if (!stalled(this.facts(task, runs.working(id).length))) return;
    this.handled.set(id, last.turn);
    const moved =
      last.ending === "finished"
        ? await crew.kick(id)
        : await crew.stuck(id, last.agent, last.ending, last.text);
    if (moved) return;
    await this.deps.pauseForOwner(id, ownerLine(id, last.agent, last.text, last.ending));
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
}
