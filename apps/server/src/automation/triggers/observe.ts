import { isAbsolute, normalize } from "node:path";
import {
  type PausedReason,
  type ProcessInfo,
  type RepoMr,
  type TaskStatus,
  taskGroup,
  type UsageTotals,
  type WatchSpec,
} from "@majhi/shared";
import { UserError } from "../../errors.ts";
import { refuseSecrets } from "../actions.ts";

/** A task as a watch sees it. */
export interface WatchTask {
  id: string;
  /** Absent for a task that belongs to no org. */
  org: string | undefined;
  status: TaskStatus;
  pausedReason: PausedReason | undefined;
  /** The merge requests of its repos. Read when asked, since most watches do not need them. */
  mrs(): { project: string; mr: RepoMr }[];
}

/** The part of majhi a watch looks at, so tests can stand in for it. */
export interface WatchHost {
  projects(): Promise<{ id: string; org: string; path: string }[]>;
  tasks(): WatchTask[];
  processes(task: string): ProcessInfo[];
  process(task: string, id: string): ProcessInfo | undefined;
  /** What the org used over the period. */
  usage(org: string, period: "today" | "week" | "month"): UsageTotals;
  /** The commit a local branch points at, or undefined when there is no such branch. */
  branchTip(checkout: string, branch: string): Promise<string | undefined>;
  /** A fingerprint of a file or folder under `checkout`, `missing` when it is not there. */
  pathPrint(checkout: string, path: string): Promise<string>;
  /** A fingerprint of the status and the start of the body. */
  urlPrint(url: string): Promise<string>;
  /** Starts the command as a process of the task, which does not wake the agent. */
  startProcess(input: {
    task: string;
    command: string;
    name: string | undefined;
    cwd: string | undefined;
  }): Promise<{ id: string }>;
}

/**
 * What a check saw. `states` is what is compared, by subject: a task, a process, or "" for a
 * watch of one thing. `detail` says in words what each subject is, and is not compared.
 */
export interface Observation {
  states: Record<string, string>;
  detail: Record<string, string>;
}

/** The two states of a condition. Any other watch compares what it sees with what it saw. */
export const ON = "on";
export const OFF = "off";

/** Watches of a condition fire when it turns on. The rest fire when what they see changes. */
export function isCondition(kind: WatchSpec["kind"]): boolean {
  return kind === "task.status" || kind === "process.exit" || kind === "usage.over";
}

/**
 * A word for the event line. The line goes into task text, which the task parser reads for
 * branches and mentions, so names lose their spaces, `@` and `#`.
 */
const token = (value: string): string => value.replace(/[\s@#]+/g, "_");

/** Names what the watch names, and checks it belongs to `org`. Throws a `UserError` when it does not. */
export async function validateWatch(org: string, spec: WatchSpec, host: WatchHost): Promise<void> {
  const ownTask = (id: string): void => {
    const task = host.tasks().find((t) => t.id === id);
    if (task === undefined) throw new UserError(`Task ${id} does not exist.`, 404);
    if (task.org !== org) {
      throw new UserError(`Task ${id} belongs to org "${task.org ?? "none"}", not "${org}".`, 409);
    }
  };
  const ownProject = async (id: string): Promise<{ id: string; org: string; path: string }> => {
    const project = (await host.projects()).find((p) => p.id === id);
    if (project === undefined) throw new UserError(`Project "${id}" does not exist.`, 404);
    if (project.org !== org) {
      throw new UserError(`Project "${id}" belongs to org "${project.org}", not "${org}".`, 409);
    }
    return project;
  };
  switch (spec.kind) {
    case "task.status":
    case "mr.changed":
      if (spec.task !== undefined) ownTask(spec.task);
      return;
    case "process.exit":
      ownTask(spec.task);
      return;
    case "command.changed":
      refuseSecrets(spec.command);
      ownTask(spec.task);
      return;
    case "branch.changed":
      await ownProject(spec.project);
      if (spec.branch.startsWith("-") || /[\s~^:?*[\\]|\.\.|\.lock$/.test(spec.branch)) {
        throw new UserError(`"${spec.branch}" is not a branch name.`);
      }
      return;
    case "path.changed": {
      await ownProject(spec.project);
      const path = normalize(spec.path);
      if (isAbsolute(path) || path === ".." || path.startsWith("../") || path.startsWith("..\\")) {
        throw new UserError(`"${spec.path}" must be inside the project: use a path relative to it.`);
      }
      return;
    }
    case "usage.over":
      return;
    case "url.changed": {
      let url: URL;
      try {
        url = new URL(spec.url);
      } catch {
        throw new UserError(`"${spec.url}" is not a URL.`);
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new UserError("Only http and https URLs can be watched.");
      }
      return;
    }
  }
}

/**
 * Looks at what a watch watches. One `Observer` serves every trigger, because a command watch
 * keeps its running process between checks.
 */
export class Observer {
  /** The process of a command watch that has not ended yet, by trigger. */
  private readonly commands = new Map<string, { task: string; process: string }>();

  constructor(private readonly host: WatchHost) {}

  /** Forgets a trigger's command in flight, after it was edited or deleted. */
  forget(trigger: string): void {
    this.commands.delete(trigger);
  }

  /**
   * What the watch sees now, or undefined when it has nothing to compare yet (a command that is
   * still running). Throws when it cannot look: a missing project, an unreachable URL.
   */
  async observe(trigger: { id: string; org: string }, spec: WatchSpec): Promise<Observation | undefined> {
    await validateWatch(trigger.org, spec, this.host);
    switch (spec.kind) {
      case "task.status": {
        const states: Record<string, string> = {};
        const detail: Record<string, string> = {};
        for (const task of this.host.tasks()) {
          if (task.org !== trigger.org || (spec.task !== undefined && task.id !== spec.task)) continue;
          states[task.id] = matchesStatus(task, spec.to) ? ON : OFF;
          detail[task.id] = `task ${task.id} reached ${spec.to}`;
        }
        return { states, detail };
      }
      case "mr.changed": {
        const states: Record<string, string> = {};
        const detail: Record<string, string> = {};
        for (const task of this.host.tasks()) {
          if (task.org !== trigger.org || (spec.task !== undefined && task.id !== spec.task)) continue;
          for (const { project, mr } of task.mrs()) {
            const subject = `${task.id}/${project}`;
            states[subject] = `${mr.number} ${mr.state} ${mr.ci}`;
            detail[subject] = `merge request ${mr.number} in task ${task.id} is ${mr.state}, checks ${mr.ci}`;
          }
        }
        return { states, detail };
      }
      case "branch.changed": {
        const project = await this.project(trigger.org, spec.project);
        const tip = await this.host.branchTip(project.path, spec.branch);
        return {
          states: { "": tip ?? "missing" },
          detail: {
            "":
              tip === undefined
                ? `ref ${token(spec.branch)} is gone`
                : `ref ${token(spec.branch)} moved to ${tip.slice(0, 8)}`,
          },
        };
      }
      case "path.changed": {
        const project = await this.project(trigger.org, spec.project);
        const print = await this.host.pathPrint(project.path, spec.path);
        return { states: { "": print }, detail: { "": `path ${token(spec.path)} changed` } };
      }
      case "process.exit": {
        const states: Record<string, string> = {};
        const detail: Record<string, string> = {};
        for (const proc of this.host.processes(spec.task)) {
          if (spec.process !== undefined && proc.id !== spec.process && proc.name !== spec.process) continue;
          const subject = `${spec.task}/${proc.id}`;
          const ended = proc.status !== "running";
          const failed = proc.status === "exited" && proc.exitCode !== 0;
          states[subject] = ended && (spec.on === "any" || failed) ? ON : OFF;
          detail[subject] =
            `process ${proc.id} of ${spec.task} ${proc.status === "stopped" ? "was stopped" : proc.exitCode === null || proc.exitCode === undefined ? "ended by a signal" : `exited with code ${proc.exitCode}`}`;
        }
        return { states, detail };
      }
      case "usage.over": {
        const totals = this.host.usage(trigger.org, spec.period);
        const value = spec.metric === "costUsd" ? totals.costUsd : totals.totalTokens;
        const shown = spec.metric === "costUsd" ? value.toFixed(2) : String(value);
        return {
          states: { "": value > spec.limit ? ON : OFF },
          detail: {
            "": `${spec.metric === "costUsd" ? "cost" : "tokens"} ${spec.period === "today" ? "today" : `this ${spec.period}`} is ${shown}, above ${spec.limit}`,
          },
        };
      }
      case "url.changed": {
        const print = await this.host.urlPrint(spec.url);
        return { states: { "": print }, detail: { "": "the watched URL changed" } };
      }
      case "command.changed":
        return this.command(trigger.id, spec);
    }
  }

  private async project(org: string, id: string): Promise<{ id: string; org: string; path: string }> {
    const project = (await this.host.projects()).find((p) => p.id === id && p.org === org);
    if (project === undefined) throw new UserError(`Project "${id}" does not exist in org "${org}".`, 404);
    return project;
  }

  /**
   * A command watch runs the command as a process of the task, one check, and compares its exit
   * and the end of its output with the last run. Between the start and the end it has nothing to say.
   */
  private async command(
    trigger: string,
    spec: Extract<WatchSpec, { kind: "command.changed" }>,
  ): Promise<Observation | undefined> {
    const going = this.commands.get(trigger);
    if (going !== undefined) {
      const proc = this.host.process(going.task, going.process);
      if (proc === undefined) {
        // majhi restarted, or the task forgot it.
        this.commands.delete(trigger);
      } else if (proc.status === "running") {
        return undefined;
      } else {
        this.commands.delete(trigger);
        const print = `${proc.status} ${proc.exitCode ?? "-"}\n${proc.tail.join("\n")}`;
        return {
          states: { "": print },
          detail: { "": `output of the command in ${spec.task} changed` },
        };
      }
    }
    const started = await this.host.startProcess({
      task: spec.task,
      command: spec.command,
      name: `watch: ${spec.command}`.slice(0, 80),
      cwd: spec.cwd,
    });
    this.commands.set(trigger, { task: spec.task, process: started.id });
    return undefined;
  }
}

/** `failed` is a task paused on an error. `needs-you` is the task list's group of that name, which includes it. */
function matchesStatus(task: WatchTask, to: "done" | "failed" | "needs-you"): boolean {
  switch (to) {
    case "done":
      return task.status === "done";
    case "failed":
      return task.status === "paused" && task.pausedReason === "error";
    case "needs-you":
      return taskGroup(task.status) === "needs-you";
  }
}

/** One line for the run's detail and for `{{event}}`: what matched, at most five things. */
export function describeEvent(obs: Observation, subjects: readonly string[]): string {
  const lines = subjects.map((s) => obs.detail[s] ?? token(s || "the watch"));
  const shown = lines.slice(0, 5).join("; ");
  return lines.length > 5 ? `${shown}; and ${lines.length - 5} more` : shown;
}
