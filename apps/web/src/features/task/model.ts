import type { AgentLive, RoomItem, Task, TaskStatus } from "@majhi/shared";
import type { DotTone } from "../../components/ui/status-dot";
import { isYourTurn, type StatusTone } from "../tasks/model";

export interface AgentState {
  label: string;
  tone: "amber" | "violet" | "red" | "muted" | "faint";
}

/** How an agent shows in the room panel. Without live data the task has not started it. */
export function agentState(live: AgentLive | undefined): AgentState {
  if (!live) return { label: "Not started", tone: "faint" };
  switch (live.status) {
    case "working":
      return { label: "Working", tone: "amber" };
    case "starting":
      return { label: "Starting", tone: "amber" };
    case "queued":
      return { label: live.slot ? `Queued, #${live.slot} in line` : "Queued", tone: "faint" };
    case "paused":
      return { label: "Paused", tone: "muted" };
    case "waiting":
      return { label: "Waiting for you", tone: "violet" };
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
      return "amber";
    case "waiting":
      return "violet";
    case "error":
      return "red";
    default:
      return "neutral";
  }
}

/** "opus-5.5" or "opus-5.5 · high": what the model chip says. */
export function modelLabel(live: AgentLive | undefined, configured: string | undefined): string | undefined {
  const model = live?.model ?? configured;
  if (!model) return undefined;
  return live?.effort ? `${model} · ${live.effort}` : model;
}

export type ActionKind = "start" | "stop" | "resume" | "none";

export interface ActionCopy {
  kind: ActionKind;
  text: string;
  tone: StatusTone | "faint";
  /** The card's border: paused tasks get the warm one. */
  warm: boolean;
}

const PAUSE_TEXT: Record<string, string> = {
  limit: "Paused: the account hit its usage limit. Resume once it resets.",
  offline: "Paused: the connection was lost. Resume when you are back online.",
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
        tone: yourTurn ? "violet" : "amber",
        warm: false,
      };
    case "paused":
      return {
        kind: "resume",
        text: PAUSE_TEXT[task.pausedReason ?? ""] ?? "Paused. Resume when you are ready.",
        tone: "coral",
        warm: true,
      };
    case "review":
      return {
        kind: "none",
        text: "Waiting for your review. Approving and opening an MR come with merge requests.",
        tone: "faint",
        warm: false,
      };
    case "mr":
      return { kind: "none", text: "The merge request is open.", tone: "green", warm: false };
    case "done":
      return {
        kind: "none",
        text: "Done. The worktree stays until you remove the task.",
        tone: "green",
        warm: false,
      };
  }
}

/** Whether the task's agents are all idle (waiting for the owner) given the live state. */
export function yourTurnFromLive(status: TaskStatus, agents: readonly AgentLive[]): boolean {
  return isYourTurn({
    status,
    working: agents.filter((a) => a.status === "working" || a.status === "starting").map((a) => a.agent),
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

/** The "Task · ..." label above the brief. */
export function briefLabel(task: Pick<Task, "kind">): string {
  return task.kind === "chat" ? "Task · chat" : "Task · local";
}

/** What the owner wrote beyond the title line. The title is the brief's first line, so it is not repeated. */
export function briefBody(brief: string, title: string): string {
  const lines = brief.trim().split(/\r?\n/);
  const first = lines[0]?.trim() ?? "";
  return first.slice(0, title.length) === title ? lines.slice(1).join("\n").trim() : brief.trim();
}
