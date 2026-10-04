import type { AccountStatus, PausedBy, PausedReason, TaskStatus } from "@majhi/shared";

/**
 * Which paused tasks the captain may resume (SPEC 5.18). Pure. It may resume what it or the Autonomous
 * switch paused, and what stopped for a cause that is gone. A task the owner paused, or that waits for
 * the owner (blocked, going in circles), is never resumed by it.
 */

export interface PausedTask {
  id: string;
  status: TaskStatus;
  pausedReason?: PausedReason | undefined;
  pausedBy?: PausedBy | undefined;
}

/** What the causes look like right now. */
export interface ResumeEnv {
  /** The accounts of the task's team, with their current status. */
  accounts: readonly { id: string; status: AccountStatus }[];
  /** A budget cap that still holds the task's workspace, as one line. */
  budgetHold?: string | undefined;
}

const SIGNED_OUT: readonly AccountStatus[] = ["needs-login"];
const UNREACHABLE: readonly AccountStatus[] = ["unreachable"];

/** Why the captain may not resume the task now, in one line; undefined when it may. */
export function resumeRefusal(task: PausedTask, env: ResumeEnv): string | undefined {
  if (task.status !== "paused") return undefined;
  if (task.pausedBy === "captain" || task.pausedBy === "autonomy-off") return undefined;
  const reason = task.pausedReason ?? "owner";
  switch (reason) {
    case "owner":
      return `Refused: the owner paused ${task.id}, so it stays paused. If it should go on, leave it as a decision for the owner.`;
    case "blocked":
    case "loop":
      return `Refused: ${task.id} paused because ${reason === "blocked" ? "it is blocked" : "its agent was going in circles"}, and that is the owner's to look at.`;
    case "limit": {
      if (env.budgetHold !== undefined) return `Refused: ${task.id} waits for a limit: ${env.budgetHold}.`;
      const full = env.accounts.find((a) => a.status === "at-limit");
      return full === undefined
        ? undefined
        : `Refused: ${task.id} waits for a limit: ${full.id} is at its limit.`;
    }
    case "signed-out": {
      const out = env.accounts.find((a) => SIGNED_OUT.includes(a.status));
      return out === undefined
        ? undefined
        : `Refused: ${task.id} waits for a sign-in: ${out.id} is signed out. Check the account again before you plan around it.`;
    }
    case "offline": {
      const gone = env.accounts.find((a) => UNREACHABLE.includes(a.status));
      return gone === undefined ? undefined : `Refused: ${task.id} waits: ${gone.id} cannot be reached.`;
    }
    case "error": {
      const bad = env.accounts.find((a) => SIGNED_OUT.includes(a.status) || UNREACHABLE.includes(a.status));
      return bad === undefined
        ? undefined
        : `Refused: ${task.id} stopped on an error and ${bad.id} is not working now.`;
    }
    default:
      return undefined;
  }
}

/** Whether the captain may resume the task now. */
export function mayResume(task: PausedTask, env: ResumeEnv): boolean {
  return task.status === "paused" && resumeRefusal(task, env) === undefined;
}

/** Who paused it, in words, for the digest. */
export function pausedLabel(task: PausedTask): string {
  if (task.pausedBy === "autonomy-off") return "paused when Autonomous was turned off";
  if (task.pausedBy === "captain") return "paused by the captain";
  switch (task.pausedReason ?? "owner") {
    case "owner":
      return "paused by the owner";
    case "limit":
      return "paused at a limit";
    case "offline":
      return "paused: agent offline";
    case "error":
      return "paused on an error";
    case "signed-out":
      return "paused: account signed out";
    case "blocked":
      return "paused: blocked";
    default:
      return "paused: going in circles";
  }
}
