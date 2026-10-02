import type { AgentLive, RoomItem, Task, TaskStatus, TaskSummary } from "@majhi/shared";
import type { LampState } from "../../components/ui/lamp";
import type { DotTone } from "../../components/ui/status-dot";
import { workingText } from "../board/model";
import { isYourTurn, statusInfo } from "../tasks/model";

export interface AgentState {
  label: string;
  tone: "working" | "needs" | "paused" | "red" | "muted" | "faint";
}

/** How an agent shows in the room panel. Without live data the task has not started it. */
export function agentState(live: AgentLive | undefined, pausedReason?: string | undefined): AgentState {
  if (!live) return { label: "Not started", tone: "faint" };
  if (live.status === "paused" && pausedReason === "offline")
    return { label: "Paused, offline", tone: "paused" };
  switch (live.status) {
    case "working":
      return { label: "Working", tone: "working" };
    case "starting":
      return { label: "Starting", tone: "working" };
    case "queued":
      return { label: live.slot ? `Queued, #${live.slot} in line` : "Queued", tone: "faint" };
    case "paused":
      return { label: "Paused", tone: "paused" };
    case "waiting":
      return { label: "Waiting for you", tone: "needs" };
    case "error":
      return { label: "Error", tone: "red" };
    case "stopped":
      return { label: "Stopped", tone: "muted" };
    case "idle":
      return { label: "Idle", tone: "faint" };
  }
}

/** The state dot on an avatar. */
export function agentDot(live: AgentLive | undefined): DotTone {
  switch (live?.status) {
    case "working":
    case "starting":
      return "working";
    case "waiting":
      return "needs";
    case "error":
      return "red";
    default:
      return "neutral";
  }
}

/** Whether an agent of the task is busy the way the server counts it (queued, starting, working, waiting). */
export function agentsBusy(agents: readonly AgentLive[]): boolean {
  return agents.some(
    (a) =>
      a.status === "queued" || a.status === "starting" || a.status === "working" || a.status === "waiting",
  );
}

/** The row's second line: what a busy agent is doing now, else "Idle". Always present, so the row keeps its height. */
export function nowDoingLine(live: AgentLive | undefined): string {
  const busy = live?.status === "working" || live?.status === "starting";
  return busy && live.nowDoing ? live.nowDoing : "Idle";
}

export type ActionKind = "start" | "stop" | "resume" | "done" | "none";

export interface ActionCopy {
  kind: ActionKind;
  text: string;
  tone: LampState | "faint";
  /** The card's border: paused tasks get the warm one. */
  warm: boolean;
}

const PAUSE_TEXT: Record<string, string> = {
  limit:
    "Paused: a weekly budget reached 100%. It continues when the budget is raised or on Monday, or resume it now.",
  offline: "majhi is offline. The task continues on its own when the connection is back.",
  error: "Paused after an error. Read the room, then resume.",
  owner: "You stopped the task. Resume when you are ready.",
};

/** The card under "In this room": one sentence and the one main action for the task's status. */
export function actionCopy(
  task: Pick<Task, "status" | "pausedReason" | "kind">,
  yourTurn: boolean,
): ActionCopy {
  switch (task.status) {
    case "inbox":
    case "ready":
      return {
        kind: "start",
        text:
          task.kind === "chat"
            ? "Starts the agent in the task folder. No worktree for a chat task."
            : "Creates a worktree on its own branch and starts the agent.",
        tone: "faint",
        warm: false,
      };
    case "running":
      return {
        kind: "stop",
        text: yourTurn
          ? "Your turn. Reply in the room, or stop the task."
          : "The agent is working. Nothing is pushed until you approve.",
        tone: yourTurn ? "needs" : "working",
        warm: false,
      };
    case "paused":
      return {
        kind: "resume",
        text: PAUSE_TEXT[task.pausedReason ?? ""] ?? "Paused. Resume when you are ready.",
        tone: "paused",
        warm: true,
      };
    case "review":
      return {
        kind: "done",
        text: "The agent finished. Reply in the room to continue, or mark it done.",
        tone: "needs",
        warm: false,
      };
    case "mr":
      return { kind: "none", text: "The merge request is open.", tone: "done", warm: false };
    case "done":
      return {
        kind: "none",
        text: "Done. The worktree stays until you remove the task.",
        tone: "done",
        warm: false,
      };
  }
}

/** Whether the task's agents are all idle (waiting for the owner) given the live state. */
export function yourTurnFromLive(status: TaskStatus, agents: readonly AgentLive[]): boolean {
  return isYourTurn({
    status,
    working: agents
      .filter((a) => a.status === "working" || a.status === "starting" || a.status === "queued")
      .map((a) => a.agent),
  });
}

export interface PendingPrompt {
  itemId: string;
  agent: string;
}

/** The first permission prompt still waiting for an answer. */
export function firstPendingPermission(items: readonly RoomItem[]): PendingPrompt | undefined {
  for (const item of items) {
    if (item.type === "permission" && item.state === "pending") return { itemId: item.id, agent: item.agent };
  }
  return undefined;
}

/** What the owner wrote beyond the title line. The title is the brief's first line, so it is not repeated. */
export function briefBody(brief: string, title: string): string {
  const lines = brief.trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  return first.slice(0, title.length) === title ? lines.slice(1).join("\n").trim() : brief.trim();
}

export interface Relations {
  parent: { id: string; title: string | undefined } | undefined;
  /** Tasks this one depends on; `waiting` is true while the dependency is not met. */
  depends: { id: string; title: string | undefined; waiting: boolean; when: "merged" | "ready" }[];
  /** Its subtasks, by id, so the order is the order they were planned in. */
  children: TaskSummary[];
  progress: { done: number; total: number } | undefined;
}

/** The task's links joined with the task list, for the header. */
export function relations(task: Pick<Task, "id" | "links">, list: readonly TaskSummary[]): Relations {
  const byId = new Map(list.map((t) => [t.id, t]));
  const me = byId.get(task.id);
  const waiting = new Set(me?.waitingOn ?? []);
  const parent = task.links.find((l) => l.type === "parent");
  const children = list
    .filter((t) => t.links.some((l) => l.type === "parent" && l.task === task.id))
    .toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return {
    parent: parent && { id: parent.task, title: byId.get(parent.task)?.title },
    depends: task.links
      .filter((l) => l.type === "depends-on")
      .map((l) => ({
        id: l.task,
        title: byId.get(l.task)?.title,
        waiting: waiting.has(l.task),
        when: l.when ?? "merged",
      })),
    children,
    progress:
      me?.children ??
      (children.length > 0
        ? { done: children.filter((c) => c.status === "done").length, total: children.length }
        : undefined),
  };
}

/** A subtask's state in one line: its lamp, its words, and the tasks it waits for. */
export interface SubtaskLine {
  lamp: LampState;
  text: string;
  waitingOn: readonly string[];
}

/**
 * "Inbox", "Ready", "Waiting on" (with the keys), "@builder working", "Your turn", "Your review",
 * "Paused · usage limit", "MR open", "Done".
 */
export function subtaskLine(
  task: Pick<TaskSummary, "status" | "working" | "waitingOn" | "pausedReason">,
): SubtaskLine {
  if ((task.status === "inbox" || task.status === "ready") && task.waitingOn.length > 0)
    return { lamp: "idle", text: "Waiting on", waitingOn: task.waitingOn };
  if (task.status === "running" && task.working.length > 0)
    return { lamp: "working", text: workingText(task.working), waitingOn: [] };
  const info = statusInfo(task.status, task.pausedReason, isYourTurn(task));
  return { lamp: info.lamp, text: info.label, waitingOn: [] };
}

/** A subtask the owner can start now: not started and waiting on nothing. */
export function canStartSubtask(task: Pick<TaskSummary, "status" | "waitingOn">): boolean {
  return (task.status === "inbox" || task.status === "ready") && task.waitingOn.length === 0;
}

/** Tasks a link can point at: open ones, not the task itself and not ones it is already linked to that way. */
export function linkTargets(
  task: Pick<Task, "id" | "links">,
  list: readonly TaskSummary[],
  type: "parent" | "depends-on",
): TaskSummary[] {
  const taken = new Set(task.links.filter((l) => l.type === type).map((l) => l.task));
  return list
    .filter((t) => t.id !== task.id && t.status !== "done" && !taken.has(t.id))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

/** The context meter: share of the window in use, 0 to 1, and "42k of 200k". */
export function contextMeter(usage: AgentLive["usage"]): { share: number; label: string } | undefined {
  if (usage === undefined || usage.size <= 0) return undefined;
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
  return { share: Math.min(1, usage.used / usage.size), label: `${k(usage.used)} of ${k(usage.size)}` };
}
