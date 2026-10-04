import {
  type AgentFrontmatter,
  type AutomationAction,
  type AutomationRun,
  canWorkIn,
  detectSecrets,
  type OverlapPolicy,
  type PausedReason,
  type ProcessInfo,
  type TaskStatus,
} from "@majhi/shared";
import { errorMessage, UserError } from "../errors.ts";
import type { RunHistory } from "./history.ts";

/** The part of majhi an action touches, so tests can stand in for it. */
export interface ActionHost {
  projects(): Promise<{ id: string; org: string; aliases: string[] }[]>;
  agent(id: string): Promise<Pick<AgentFrontmatter, "id" | "scope" | "where"> | undefined>;
  /** `org` is absent for a task that belongs to no org. */
  task(id: string):
    | {
        id: string;
        org: string | undefined;
        status: TaskStatus;
        pausedReason: PausedReason | undefined;
        team: string[];
      }
    | undefined;
  /** Creates the task and starts it, as `tasks.create` with `start` does. */
  startTask(input: {
    text: string;
    /** The one project the task changes. */
    project: string;
    agent: string | undefined;
    team: string[] | undefined;
  }): Promise<{ id: string }>;
  /** Tells the task's lead, as a message from the scheduler. Wakes the task like an owner message. */
  postToTask(input: { task: string; text: string; from: string }): Promise<void>;
  startProcess(input: {
    task: string;
    command: string;
    name: string | undefined;
    cwd: string | undefined;
  }): Promise<{ id: string }>;
  process(task: string, id: string): ProcessInfo | undefined;
}

/** What starts a run: a schedule or a watch trigger. */
export interface RunSource {
  kind: "schedule" | "trigger" | "watch";
  id: string;
  org: string;
  /** Shown in rooms: "Nightly build". */
  name: string;
}

/**
 * Refuses text that holds a secret: an automation is stored as written, and its text reaches
 * agents and rooms. The value is never in the message.
 */
export function refuseSecrets(...texts: (string | undefined)[]): void {
  for (const text of texts) {
    if (text !== undefined && detectSecrets(text).length > 0) {
      throw new UserError("This looks like a secret. Save it with secrets.save and refer to it by name.");
    }
  }
}

/** The text a started task gets: the owner's title and text. Its repo is passed on its own. */
export function taskText(action: Extract<AutomationAction, { kind: "task.start" }>): string {
  return `${action.title}\n\n${action.text}`;
}

/**
 * Runs actions for schedules and for watch triggers, and keeps their history. One place decides
 * what an action may touch (its org), when a run still goes (for overlap) and how a run ends.
 */
export class ActionRunner {
  /** Runs of one source go one at a time, so two firings cannot both pass the overlap check. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** Runs recorded but not yet started: `reconcile` must not end them. */
  private readonly starting = new Set<number>();

  constructor(
    private readonly host: ActionHost,
    readonly history: RunHistory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Checks that everything the action names belongs to `org`. Run when a schedule is saved and
   * again at every run, because projects, agents and tasks can change between.
   */
  async validate(org: string, action: AutomationAction): Promise<void> {
    switch (action.kind) {
      case "task.start": {
        refuseSecrets(action.title, action.text);
        const projects = await this.host.projects();
        const project = projects.find((p) => p.id === action.project);
        if (project === undefined) throw new UserError(`Project "${action.project}" does not exist.`, 404);
        if (project.org !== org) {
          throw new UserError(
            `Project "${action.project}" belongs to org "${project.org}", not "${org}".`,
            409,
          );
        }
        for (const id of action.team ?? (action.agent === undefined ? [] : [action.agent])) {
          const agent = await this.host.agent(id);
          if (agent === undefined) throw new UserError(`Agent "${id}" does not exist.`, 404);
          if (!canWorkIn(agent, org)) throw new UserError(`Agent "${id}" may not work in org "${org}".`, 409);
        }
        return;
      }
      case "room.post":
      case "process.run": {
        refuseSecrets(action.kind === "room.post" ? action.text : action.command);
        const task = this.host.task(action.task);
        if (task === undefined) throw new UserError(`Task ${action.task} does not exist.`, 404);
        if (task.org !== org) {
          throw new UserError(
            `Task ${action.task} belongs to org "${task.org ?? "none"}", not "${org}".`,
            409,
          );
        }
        return;
      }
    }
  }

  /**
   * Runs the action for `source` and records the run. With `skip`, a run that finds the last one
   * still going is recorded as `skipped` and starts nothing. Never throws for a failed action: the
   * run is recorded as `failed` with the reason.
   */
  run(source: RunSource, action: AutomationAction, overlap: OverlapPolicy): Promise<AutomationRun> {
    const key = `${source.kind}:${source.id}`;
    const turn = (this.queues.get(key) ?? Promise.resolve()).then(() => this.runNow(source, action, overlap));
    const settled = turn.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return turn;
  }

  private async runNow(
    source: RunSource,
    action: AutomationAction,
    overlap: OverlapPolicy,
  ): Promise<AutomationRun> {
    const at = this.now().toISOString();
    const base = { sourceKind: source.kind, sourceId: source.id, org: source.org, startedAt: at } as const;
    await this.reconcile(source);
    if (overlap === "skip") {
      const going = this.history.running({ kind: source.kind, id: source.id })[0];
      if (going !== undefined) {
        return this.history.add({
          ...base,
          endedAt: at,
          status: "skipped",
          detail: `Skipped: the run from ${going.startedAt} is still going (${going.detail}).`,
        });
      }
    }
    try {
      await this.validate(source.org, action);
    } catch (err) {
      return this.history.add({ ...base, endedAt: at, status: "failed", detail: errorMessage(err) });
    }
    const run = this.history.add({ ...base, status: "running", detail: "Starting" });
    this.starting.add(run.id);
    try {
      const started = await this.start(source, action);
      this.history.started(run.id, started);
      // A post has nothing that keeps going.
      if (action.kind === "room.post")
        return this.history.finish(run.id, "ok", started.detail, this.now().toISOString());
      return this.history.get(run.id) ?? run;
    } catch (err) {
      return this.history.finish(run.id, "failed", errorMessage(err), this.now().toISOString());
    } finally {
      this.starting.delete(run.id);
    }
  }

  private async start(
    source: RunSource,
    action: AutomationAction,
  ): Promise<{ detail: string; taskId?: string; processId?: string }> {
    switch (action.kind) {
      case "task.start": {
        const task = await this.host.startTask({
          text: taskText(action),
          project: action.project,
          agent: action.agent,
          team: action.team,
        });
        return { detail: `Started task ${task.id}`, taskId: task.id };
      }
      case "room.post":
        await this.host.postToTask({ task: action.task, text: action.text, from: source.name });
        return { detail: `Posted to ${action.task}`, taskId: action.task };
      case "process.run": {
        const process = await this.host.startProcess({
          task: action.task,
          command: action.command,
          name: action.name,
          cwd: action.cwd,
        });
        return {
          detail: `Started ${process.id} in ${action.task}`,
          taskId: action.task,
          processId: process.id,
        };
      }
    }
  }

  /**
   * Ends the runs whose task is done, waits for the owner or failed, or whose process exited. A process does not outlive majhi, so
   * a process run left over from before a restart ends as failed. Of one source, or of all.
   */
  async reconcile(source?: { kind: "schedule" | "trigger" | "watch"; id: string }): Promise<void> {
    for (const run of this.history.running(source)) {
      if (this.starting.has(run.id)) continue;
      const ended = this.outcome(run);
      if (ended !== undefined)
        this.history.finish(run.id, ended.status, ended.detail, this.now().toISOString());
    }
  }

  /** How a run that has not ended stands now: undefined while it still goes. */
  private outcome(run: AutomationRun): { status: "ok" | "failed"; detail: string } | undefined {
    if (run.processId !== null && run.taskId !== null) {
      const process = this.host.process(run.taskId, run.processId);
      if (process === undefined) {
        return {
          status: "failed",
          detail: `${run.processId} in ${run.taskId} is gone: majhi restarted before it ended.`,
        };
      }
      if (process.status === "running") return undefined;
      const code = process.exitCode;
      return code === 0
        ? { status: "ok", detail: `${run.processId} in ${run.taskId} exited with 0.` }
        : {
            status: "failed",
            detail:
              process.stoppedBy !== undefined
                ? `${run.processId} in ${run.taskId} was stopped.`
                : `${run.processId} in ${run.taskId} exited with ${code ?? "a signal"}.`,
          };
    }
    if (run.taskId !== null) {
      const task = this.host.task(run.taskId);
      if (task === undefined) return { status: "ok", detail: `Task ${run.taskId} was removed.` };
      // The task is waiting for the owner (review, an open MR) or finished: the work of this run is
      // over, so the next run may start. A task that paused on an error will not go on by itself.
      if (task.status === "done") return { status: "ok", detail: `Task ${run.taskId} is done.` };
      if (task.status === "review" || task.status === "mr") {
        return {
          status: "ok",
          detail: `Task ${run.taskId} is ${task.status === "mr" ? "in a merge request" : "in review"}.`,
        };
      }
      if (task.status === "paused" && task.pausedReason === "error") {
        return { status: "failed", detail: `Task ${run.taskId} paused on an error.` };
      }
      return undefined;
    }
    // Nothing was started, so nothing can still go.
    return { status: "failed", detail: "The run did not finish: majhi stopped while it started." };
  }
}

/** `{{event}}` in the text of an action, so a message or a task can say what happened. */
export function withEvent(action: AutomationAction, event: string): AutomationAction {
  const fill = (text: string): string => text.split("{{event}}").join(event);
  switch (action.kind) {
    case "room.post":
      return { ...action, text: fill(action.text) };
    case "task.start":
      return { ...action, title: fill(action.title), text: fill(action.text) };
    case "process.run":
      // A command is never filled in: what matched may hold anything a repo or a page says.
      return action;
  }
}
