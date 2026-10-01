import type { LeadStart, TaskStatus } from "@majhi/shared";

export interface LeadStartTask {
  id: string;
  org?: string | undefined;
  /** The lead first. */
  team: readonly string[];
}

export type LeadStartCheck =
  | { ok: true }
  /** Nothing to do: the task already runs. */
  | { ok: true; running: true }
  /** `hard`: no approval card can change this (another org, a done task), so the call is refused outright. */
  | { ok: false; why: string; hard: boolean };

/**
 * Whether a lead may start `target` without the owner's click, under the org's `lead_start`
 * setting. Pure: the caller reads the setting and the tasks. A refusal that is not `hard` falls
 * back to a normal approval card. Only a task that never ran (inbox, ready) starts on its own:
 * resuming a paused task or pulling one back from review stays the owner's call.
 */
export function leadMayStart(input: {
  callerTask: LeadStartTask;
  callerAgent: string;
  target: LeadStartTask & { parent?: string | undefined; status: TaskStatus };
  setting: LeadStart;
}): LeadStartCheck {
  const { callerTask, callerAgent, target, setting } = input;
  if (callerTask.org === undefined && target.org === undefined) {
    return { ok: false, hard: false, why: "Tasks without an org start only when the owner says so." };
  }
  if (target.org !== callerTask.org) {
    return { ok: false, hard: true, why: `${target.id} is not in the org of ${callerTask.id}.` };
  }
  if (target.status === "done") return { ok: false, hard: true, why: `${target.id} is done.` };
  if (callerTask.team[0] !== callerAgent) {
    return { ok: false, hard: false, why: `@${callerAgent} is not the lead of ${callerTask.id}.` };
  }
  if (setting === "off") return { ok: false, hard: false, why: "Leads may not start tasks in this org." };
  if (setting === "children") {
    if (target.parent !== callerTask.id) {
      return { ok: false, hard: false, why: `${target.id} is not a subtask of ${callerTask.id}.` };
    }
  } else if (target.id === callerTask.id) {
    return { ok: false, hard: false, why: "A lead does not start its own task." };
  }
  if (target.status === "running") return { ok: true, running: true };
  if (target.status !== "inbox" && target.status !== "ready") {
    return {
      ok: false,
      hard: false,
      why: `${target.id} is ${target.status}: the owner decides whether it runs again.`,
    };
  }
  return { ok: true };
}
