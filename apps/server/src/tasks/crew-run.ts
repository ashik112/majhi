import { randomUUID } from "node:crypto";
import {
  PLAN_STEPS_MAX,
  STEP_SEND_BACKS_MAX,
  type Task,
  type TaskId,
  type TeamPlan,
  WORKERS_MAX,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { RoomService } from "../room/service.ts";
import type { RunManager } from "../runs/manager.ts";
import type { Store } from "../store/index.ts";
import {
  allDown,
  begin,
  type DownAccount,
  doing,
  doingBy,
  finish,
  type Hand,
  hasRoomForWorker,
  newLead,
  next,
  noteResult,
  oneLine,
  ownerOf,
  pickReviewer,
  progressLines,
  type ReviewerCandidate,
  replacement,
  sendBack,
  statusOf,
  stepPrompt,
  stoppedStep,
  unfinished,
} from "./crew.ts";
import type { TaskPlans } from "./plans.ts";

/** What the crew needs from the task service, so the two never import each other. */
export interface CrewHost {
  /** Adds a worker (it must be allowed to work in the task's workspace). */
  addToTeam(id: string, agent: string, options: { by: string }): Promise<Task>;
  /** The task waits for the owner, with this line in the room and on its card. */
  pauseForOwner(id: string, text: string): Promise<void>;
  /** Every agent is down: the task pauses at its checkpoint with a hold that names each fix. */
  pauseDown(id: string, down: readonly DownAccount[]): Promise<void>;
  /** Each member of the task's team: can it run now, what it has left, what it cost. */
  hands(task: Task): Promise<Hand[]>;
  /** The agents that could review: the team and the ones that could join, with their model's price. */
  reviewers(task: Task): Promise<ReviewerCandidate[]>;
  /** The cheapest model the agent's account offers, from the ranking. Undefined when it offers one or none. */
  cheapestModel(agent: string): Promise<string | undefined>;
  /** The owner's model for one agent in this task. */
  setModel(task: string, agent: string, model: string): Promise<void>;
}

export interface CrewDeps {
  store: Store;
  room: RoomService;
  runs: Pick<RunManager, "handoff" | "working" | "hasWork" | "remove" | "handOn">;
  plans: TaskPlans;
  host: CrewHost;
}

/** The review step the plan ends with when the workspace asks for a review before the owner. */
export const REVIEW_STEP = (last: number): string =>
  `Review the work of steps 1 to ${last} against the task. If it needs changes, call send_back with the number of the step to redo and why, then end your turn. If it is good, say so in one line.`;

/**
 * Lead and workers. The lead records a short plan; each step names the agent that owns it, and the steps
 * run one at a time. majhi hands each step to its owner; a worker never gets work any other way. A worker
 * that cannot run has its step moved to another agent from the last checkpoint; a lead that cannot run is
 * replaced by the worker with the most headroom; when nobody can run the task pauses until one can.
 */
export class Crew {
  /** One change of a task's steps at a time, so a step is never handed on twice. */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: CrewDeps) {}

  private serial<T>(task: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chain.get(task) ?? Promise.resolve();
    const done = previous.then(run, run);
    const tail = done.catch(() => undefined);
    this.chain.set(task, tail);
    void tail.then(() => {
      if (this.chain.get(task) === tail) this.chain.delete(task);
    });
    return done;
  }

  private say(task: string, level: "info" | "warn", text: string): void {
    this.deps.room.post(task as TaskId, `${level}:${randomUUID()}`, { type: "system", level, text });
  }

  // ---------------------------------------------------------------------------
  // The lead's plan

  /**
   * `record_plan`: the lead's plan becomes the steps. Each worker it names joins the team (at most
   * `WORKERS_MAX`), and when the workspace asks for a review before the owner the plan ends with one.
   */
  async record(task: Task, agent: string, plan: TeamPlan, options: { review: boolean }): Promise<string> {
    const lead = task.team[0];
    if (agent !== lead) throw new UserError(`Only the lead, @${lead ?? "nobody"}, records the plan.`);
    let current = task;
    const names = new Set<string>();
    for (const step of plan.steps) {
      const who = step.who.trim().replace(/^@/, "").toLowerCase();
      if (who === "me" || who === "" || names.has(who)) continue;
      names.add(who);
      if (current.team.some((a) => a.toLowerCase() === who)) continue;
      if (!hasRoomForWorker(current.team))
        throw new UserError(
          `A task has the lead and at most ${WORKERS_MAX} workers: ${current.team.map((a) => `@${a}`).join(", ")}. Give @${who}'s steps to one of them.`,
        );
      current = await this.deps.host.addToTeam(current.id, who, { by: agent });
    }
    // The steps start fresh: progress belongs to what majhi ran, never to what an agent wrote.
    const steps = plan.steps.map((s) => ({ who: s.who, what: s.what }));
    let reviewer: string | undefined;
    if (options.review) reviewer = await this.reviewStep(current, steps);
    const recorded = await this.deps.plans.record(current, agent, { ...plan, steps });
    // The lead's turn ends next; its steps start when it does.
    return reviewer === undefined
      ? recorded
      : `${recorded} The plan ends with a review by @${reviewer}, on a cheaper model when its account offers one.`;
  }

  /** Adds the review step and gives the reviewer the cheapest model of its account. Returns who reviews. */
  private async reviewStep(task: Task, steps: { who: string; what: string }[]): Promise<string | undefined> {
    const { host } = this.deps;
    const lead = task.team[0] ?? "";
    const taken = new Set(steps.map((s) => ownerOf(s, task.team)));
    const candidates = (await host.reviewers(task)).filter((c) => c.inTeam || hasRoomForWorker(task.team));
    // A reviewer that builds nothing in this plan, so a cheaper model costs the work no quality.
    const free = candidates.filter((c) => !taken.has(c.id));
    const pick = pickReviewer(free.length > 0 ? free : candidates, lead);
    // The lead reviewing its own plan is no review: with nobody else to ask, the plan ends where the lead's steps do.
    if (pick === undefined || pick.id === lead) return undefined;
    if (steps.length >= PLAN_STEPS_MAX)
      throw new UserError(
        `A plan has at most ${PLAN_STEPS_MAX} steps, and this workspace ends it with a review before the owner: give ${PLAN_STEPS_MAX - 1} steps or fewer. Join steps together.`,
      );
    let now = task;
    if (!pick.inTeam) now = await host.addToTeam(task.id, pick.id, { by: lead });
    const model = taken.has(pick.id) ? undefined : await host.cheapestModel(pick.id);
    if (model !== undefined) await host.setModel(now.id, pick.id, model);
    steps.push({ who: pick.id === lead ? "me" : pick.id, what: REVIEW_STEP(steps.length) });
    return pick.id;
  }

  // ---------------------------------------------------------------------------
  // Running the steps

  /**
   * An agent ended a turn with this last message. When it owns the step in progress, the step is done: one
   * result line goes in the room (what it reported with `step_done`, else the first line of the message) and
   * the next step starts. Anything else it said goes nowhere: no mention wakes anyone.
   */
  turnEnded(taskId: string, agent: string, text: string): Promise<void> {
    return this.serial(taskId, async () => {
      const task = this.deps.store.tasks.get(taskId);
      if (task === undefined || task.status !== "running") return;
      const plan = this.deps.plans.latest(taskId)?.plan;
      if (plan === undefined) return;
      const i = doingBy(plan, agent, task.team);
      if (i !== undefined) {
        const result = plan.steps[i]?.result ?? oneLine(text);
        const done = this.deps.plans.update(taskId, (p) => finish(p, i, result === "" ? "done" : result));
        if (done !== undefined)
          this.say(
            taskId,
            "info",
            `Step ${i + 1} of ${done.steps.length} done by @${agent}: ${done.steps[i]?.result ?? "done"}`,
          );
      }
      await this.advance(task, agent);
    });
  }

  /** The agent's own one-line result for its step, kept until its turn ends. */
  stepDone(taskId: string, agent: string, result: string): string {
    const task = this.deps.store.tasks.get(taskId);
    const plan = this.deps.plans.latest(taskId)?.plan;
    const i = task === undefined || plan === undefined ? undefined : doingBy(plan, agent, task.team);
    if (i === undefined) return "You have no step in the plan right now. Nothing to report.";
    this.deps.plans.update(taskId, (p) => noteResult(p, i, result));
    return `Noted. Step ${i + 1} is done when your turn ends.`;
  }

  /**
   * The reviewer (or any agent on a later step) sends a finished step back: that step and every one after
   * it up to the caller's own run again. The second time the same step is sent back it stops, and the task
   * goes to the owner with the reason.
   */
  sendBack(taskId: string, agent: string, stepNo: number, reason: string): Promise<string> {
    return this.serial(taskId, async () => {
      const task = this.deps.store.tasks.get(taskId);
      const plan = this.deps.plans.latest(taskId)?.plan;
      if (task === undefined || plan === undefined) throw new UserError("This task has no plan.");
      const by = doingBy(plan, agent, task.team);
      if (by === undefined)
        throw new UserError("You have no step in the plan right now, so none to send back from.");
      const target = stepNo - 1;
      if (target < 0 || target >= by || statusOf(plan.steps[target] ?? { who: "me", what: "" }) !== "done")
        throw new UserError(`Step ${stepNo} is not a finished step before yours (step ${by + 1}).`);
      let stopped = false;
      this.deps.plans.update(taskId, (p) => {
        const moved = sendBack(p, target, by, reason);
        stopped = moved.stopped;
        return moved.plan;
      });
      const why = oneLine(reason, 300);
      if (stopped) {
        // Not awaited: stopping waits for this agent's turn to end, and this call is part of that turn.
        void this.deps.host
          .pauseForOwner(
            taskId,
            `Step ${stepNo} was sent back ${STEP_SEND_BACKS_MAX} times and stopped. The last reason: ${why}`,
          )
          .catch(() => undefined);
        return `Step ${stepNo} stopped: it was sent back ${STEP_SEND_BACKS_MAX} times. The owner decides.`;
      }
      this.say(taskId, "info", `@${agent} sent step ${stepNo} back: ${why}`);
      return `Step ${stepNo} goes back to its owner. End your turn: your own step runs again after it.`;
    });
  }

  /**
   * Looks at the plan and starts what should run: nothing when an agent is on the step in progress, the
   * same step again when its owner has nothing to do (a lost handoff), else the next step. `except` is the
   * agent whose turn is ending, which no longer counts as working.
   */
  private async advance(task: Task, except?: string): Promise<void> {
    const { plans, runs, host } = this.deps;
    const plan = plans.latest(task.id)?.plan;
    if (plan === undefined || stoppedStep(plan) !== undefined) return;
    const lead = task.team[0];
    if (lead === undefined) return;
    const working = runs.working(task.id).filter((a) => a !== except);
    const hands = await host.hands(task);
    const now = this.deps.store.tasks.get(task.id);
    if (now === undefined || now.status !== "running") return;
    const index = doing(plan) ?? next(plan);
    if (index === undefined) return;
    const step = plan.steps[index];
    if (step === undefined) return;
    const owner = ownerOf(step, task.team) ?? lead;
    const onIt = statusOf(step) === "doing";
    // Someone is on the step, or another agent is in a turn that may hand work back: wait for it.
    if (onIt && (runs.hasWork(task.id, owner) || working.includes(owner))) return;
    if (!onIt && working.length > 0) return;
    const up = hands.find((h) => h.id === owner)?.up !== false;
    const to = up ? owner : replacement(hands, owner, lead);
    if (to === undefined) {
      const down = allDown(hands);
      // Not awaited: this may run at the end of an agent's turn, and stopping waits for that turn to end.
      if (down.length > 0) void host.pauseDown(task.id, down).catch(() => undefined);
      return;
    }
    const started = plans.update(task.id, (p) => begin(p, index, to, lead));
    if (started === undefined) return;
    if (to !== owner)
      this.say(
        task.id,
        "info",
        `@${owner} cannot run now, so @${to} takes step ${index + 1} of ${started.steps.length}.`,
      );
    runs.handoff(task, {
      from: "majhi",
      to,
      via: "plan",
      text: stepPrompt(
        started,
        index,
        to,
        to !== owner
          ? `@${owner} could not run, so the step is yours. Its work so far is in the worktree.`
          : undefined,
      ),
    });
  }

  /** The idle watch found nobody working on a plan that is not finished: put the step back to work. */
  kick(taskId: string): Promise<boolean> {
    return this.serial(taskId, async () => {
      const task = this.deps.store.tasks.get(taskId);
      const plan = this.deps.plans.latest(taskId)?.plan;
      if (task === undefined || task.status !== "running" || plan === undefined) return false;
      if (!unfinished(plan)) return false;
      await this.advance(task);
      return true;
    });
  }

  /**
   * An agent's turn failed, or its model's safeguards stopped it with no other model to try: its step goes
   * to another agent that can run, from the last checkpoint. False when nobody else can take it.
   */
  stuck(taskId: string, agent: string, ending: "refused" | "failed", text: string): Promise<boolean> {
    return this.serial(taskId, async () => {
      const task = this.deps.store.tasks.get(taskId);
      const plan = this.deps.plans.latest(taskId)?.plan;
      const lead = task?.team[0];
      if (task === undefined || plan === undefined || lead === undefined || task.status !== "running")
        return false;
      const i = doingBy(plan, agent, task.team);
      if (i === undefined) return false;
      const to = replacement(await this.deps.host.hands(task), agent, lead);
      if (to === undefined) return false;
      const what = ending === "refused" ? "was blocked by its model's safeguards" : "failed";
      const started = this.deps.plans.update(taskId, (p) => begin(p, i, to, lead));
      if (started === undefined) return false;
      this.say(
        taskId,
        "info",
        `@${agent} ${what}, so @${to} takes step ${i + 1} of ${started.steps.length}.`,
      );
      const quote = oneLine(text, 200);
      this.deps.runs.handoff(task, {
        from: "majhi",
        to,
        via: "plan",
        text: stepPrompt(
          started,
          i,
          to,
          `@${agent} ${what}${quote === "" ? "" : `: ${quote}`}. The step is yours. Its work so far is in the worktree; carry on from the last checkpoint.`,
        ),
      });
      return true;
    });
  }

  /** Whether the task has a plan with a step still to do. */
  unfinished(taskId: string): boolean {
    const plan = this.deps.plans.latest(taskId)?.plan;
    return plan !== undefined && unfinished(plan);
  }

  // ---------------------------------------------------------------------------
  // When an agent is down

  /**
   * Who takes over from `agent`, whose account cannot run now. A worker's step goes to the best other agent
   * (a worker or the lead); the lead is replaced by the worker with the most headroom. Undefined when nobody
   * else can run: the caller then tries the agent's own fallback, and else the task pauses.
   */
  async successor(taskId: string, agent: string): Promise<{ to: string; how: "step" | "lead" } | undefined> {
    const task = this.deps.store.tasks.get(taskId);
    const lead = task?.team[0];
    if (task === undefined || lead === undefined || task.team.length < 2 || !task.team.includes(agent))
      return undefined;
    const hands = await this.deps.host.hands(task);
    if (agent === lead) {
      const to = newLead(hands, lead);
      return to === undefined ? undefined : { to, how: "lead" };
    }
    const to = replacement(hands, agent, lead);
    return to === undefined ? undefined : { to, how: "step" };
  }

  /** `from`'s step now belongs to `to`: the plan says so, so the next look finds it with its new owner. */
  moved(taskId: string, from: string, to: string, how: "step" | "lead" | "fallback"): void {
    const task = this.deps.store.tasks.get(taskId);
    if (task === undefined) return;
    const lead = task.team[0] ?? "";
    this.deps.plans.update(taskId, (plan) => {
      // A promoted lead leads: its steps named `me` follow it with no change. A fallback took the agent's
      // place in the team, so every step that named the agent names the fallback.
      if (how === "lead") return undefined;
      const team = [...task.team, from];
      const i = doingBy(plan, from, team);
      const steps = plan.steps.map((s, j) => {
        const named = ownerOf(s, team) === from && s.who !== "me";
        if (how === "fallback" && named) return { ...s, who: to };
        if (how === "step" && j === i) return { ...s, who: to === lead ? "me" : to };
        return s;
      });
      return { ...plan, steps };
    });
  }

  /** The agents of the task that cannot run, with what each needs, when none can. */
  async downAll(task: Task): Promise<DownAccount[]> {
    return allDown(await this.deps.host.hands(task));
  }

  /**
   * A task paused because every agent was down: when any can run again, the step goes to the best one.
   * The run that was cut is closed and its pending prompts move with it, so the step runs once.
   * Returns true when the task can start again.
   */
  async recovered(task: Task): Promise<boolean> {
    const hands = await this.deps.host.hands(task);
    return hands.some((h) => h.up);
  }

  /**
   * The task starts again (an owner's resume, a slot that freed, an account that came back): who starts. The
   * agent running the step in progress, when it can run; else the best agent that can, which takes the step
   * and the pending prompts of the run that was cut (that run is closed, so the step runs once). Undefined
   * for a task with no step in progress: the lead starts.
   */
  resumeAgent(taskId: string): Promise<string | undefined> {
    return this.serial(taskId, async () => {
      const task = this.deps.store.tasks.get(taskId);
      const plan = this.deps.plans.latest(taskId)?.plan;
      const lead = task?.team[0];
      if (task === undefined || plan === undefined || lead === undefined) return undefined;
      const index = doing(plan);
      const step = index === undefined ? undefined : plan.steps[index];
      if (index === undefined || step === undefined) return undefined;
      const owner = ownerOf(step, task.team) ?? lead;
      const hands = await this.deps.host.hands(task);
      if (hands.find((h) => h.id === owner)?.up !== false) return owner;
      const to = replacement(hands, owner, lead);
      if (to === undefined) return owner;
      const pending = await this.deps.runs.remove(task.id, owner);
      this.deps.plans.update(task.id, (p) => begin(p, index, to, lead));
      this.say(
        task.id,
        "info",
        `@${owner} is still down, so @${to} takes step ${index + 1} of ${plan.steps.length} from the last checkpoint.`,
      );
      this.deps.runs.handOn(
        task.id,
        owner,
        to,
        pending,
        `@${owner} could not run and you took its step. Read TASK.md and the room, then carry on from the last checkpoint.`,
      );
      return to;
    });
  }

  /** The plan as lines for a handoff note or TASK.md, or none without a plan. */
  progress(taskId: string): string[] {
    const plan = this.deps.plans.latest(taskId)?.plan;
    return plan === undefined ? [] : progressLines(plan);
  }
}
