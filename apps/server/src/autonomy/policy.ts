import {
  type AutonomyHold,
  type AutonomySettings,
  type CommandName,
  commands,
  isDestructiveCommand,
  type MergePolicy,
} from "@majhi/shared";
import { holdCovering } from "./spend.ts";

/**
 * How autonomous mode decides a call that would wait for the owner (PRV-74, rule 4): hard limits
 * first (refused), then the holds on work that starts (left), then the table below. Pure, so the
 * table is tested alone; the admin service carries out the verdict.
 */

export interface AutonomyCall {
  command: CommandName;
  /** The parsed input. */
  input: Record<string, unknown>;
  /** The org the call acts in, `private` for none: its push and merge settings and its cap. */
  org: string;
  /** The caller asked for the owner's click whatever the policy says: a fix task's start. */
  confirm: boolean;
}

export interface PolicyContext {
  settings: Pick<AutonomySettings, "orgs">;
  /** The org's own merge policy for its MRs. Absent: never. */
  orgMerge?: MergePolicy | undefined;
  holds: readonly AutonomyHold[];
  /** The accounts of the agents that would do the work. */
  accounts: readonly string[];
  /** The hard limit the call breaks, if one does. */
  refused?: string | undefined;
  /** The org's name, for the lines. */
  orgName?: string | undefined;
  /** For an automation's update: the kind of action it has now (`task.start`, `room.post`, `process.run`). */
  automationAction?: string | undefined;
}

export type AutonomyVerdict =
  | { decision: "approved"; why: string }
  | { decision: "left"; why: string }
  | { decision: "refused"; why: string };

/** Calls that start agents working: they wait while a cap or a floor holds the work. */
export function startsWork(command: string, input: Record<string, unknown>): boolean {
  if (command === "tasks.start" || command === "team.add" || command === "tasks.addAgent") return true;
  return (command === "tasks.create" || command === "tasks.split") && input.start === true;
}

/** What the owner alone decides: which repos, folders and branches agents reach. */
const OWNER_REACH: ReadonlySet<string> = new Set([
  "projects.register",
  "projects.update",
  "projects.remove",
  "workspaces.set",
  "orgs.removeGitAccount",
  "tasks.changeBranch",
]);

/**
 * The owner's own settings, and what decides money and what runs: model prices (spend is counted with
 * them), the images service containers may run, and installing the decision model.
 */
const OWNER_SETTINGS: ReadonlySet<string> = new Set([
  "settings.set",
  "boss.set",
  "history.undo",
  "decisions.set",
  "system.update",
  "cleanup.run",
  "usage.setPrice",
  "containers.images.allow",
  "decisions.install",
]);

/** The owner's answers to cards. The captain answers cards with majhi_autonomy_answer instead. */
const OWNER_ANSWERS: ReadonlySet<string> = new Set(["room.answerAsk", "room.answerQuestion"]);

/** Git accounts and tokens of one org: the hard limits already checked they are this org's. */
const GIT_ACCESS: ReadonlySet<string> = new Set([
  "orgs.setGitAccount",
  "orgs.useGitLogin",
  "orgs.useSavedLogin",
]);

/** `orgs.update` fields that change identity, git accounts, or what agents may do alone. */
/** `orgs.update` fields that change identity, git accounts, where merges land, or what agents may do alone. */
const SENSITIVE_ORG_FIELDS = ["identity", "commits", "git_accounts", "merge", "lead_start", "base"] as const;

/** Automations that start tasks or run commands later, outside the run gate and the caps. */
const AUTOMATION_EDITS: ReadonlySet<string> = new Set([
  "schedules.create",
  "schedules.update",
  "triggers.create",
  "triggers.update",
]);
const AUTOMATION_STARTS: ReadonlySet<string> = new Set([
  "schedules.resume",
  "schedules.runNow",
  "triggers.resume",
  "triggers.runNow",
]);

export function decideAutonomously(call: AutonomyCall, ctx: PolicyContext): AutonomyVerdict {
  if (ctx.refused !== undefined) return { decision: "refused", why: ctx.refused };
  const starts = startsWork(call.command, call.input);
  if (starts) {
    const hold = holdCovering(ctx.holds, call.org, ctx.accounts);
    if (hold !== undefined) return left(hold.text);
  }
  const { command, input } = call;
  const risk = commands[command].risk;
  const name = ctx.orgName ?? call.org;
  const own = ctx.settings.orgs[call.org];
  if (call.confirm) return left("A fix task starts only when the owner approves it");
  if (risk === "destructive" || isDestructiveCommand(command)) return left("Only the owner removes things");
  if (OWNER_REACH.has(command))
    return left("Only the owner changes which repos, folders and branches agents reach");
  if (OWNER_SETTINGS.has(command)) return left("These are the owner's settings");
  if (OWNER_ANSWERS.has(command))
    return left("The owner's answer; the captain answers with majhi_autonomy_answer");
  if (command === "orgs.update") {
    const touched = SENSITIVE_ORG_FIELDS.filter((f) => input[f] !== undefined);
    if (touched.length > 0)
      return left(`Only the owner changes an org's ${touched.join(", ").replaceAll("_", " ")}`);
    return approved(
      input.mr_tokens === undefined ? "A change within the limits" : `Tokens ${name} already has`,
    );
  }
  if (GIT_ACCESS.has(command)) return approved(`A git account or token of ${name} only`);
  if (AUTOMATION_STARTS.has(command)) {
    return left(
      "An automation's runs start outside autonomous mode's caps and stops, so only the owner starts one",
    );
  }
  if (AUTOMATION_EDITS.has(command)) {
    const action = (input.action as { kind?: unknown } | undefined)?.kind ?? ctx.automationAction;
    if (action === "task.start" || action === "process.run") {
      return left(
        "An automation that starts tasks or runs commands works outside autonomous mode's caps and stops",
      );
    }
  }
  if (command === "tasks.merge") {
    return own?.merge === true
      ? approved(`${name} lets autonomous mode merge`)
      : left(`${name} does not let autonomous mode merge`);
  }
  if (command === "tasks.push" || command === "tasks.openMrs") {
    return own?.push === true
      ? approved(`${name} lets autonomous mode push`)
      : left(`${name} does not let autonomous mode push`);
  }
  if (command === "tasks.mergeMrs" || command === "tasks.markMerged") {
    if (own?.merge !== true) return left(`${name} does not let autonomous mode merge`);
    if ((ctx.orgMerge ?? "never") === "never") return left(`${name}'s merge policy is never`);
    return approved(`${name} lets autonomous mode merge, and its merge policy allows it`);
  }
  if (risk === "outbound") return left("It reaches outside majhi, which only the owner allows");
  if (starts) return approved("No cap or floor holds this work");
  return approved("A change within the limits");
}

function approved(why: string): AutonomyVerdict {
  return { decision: "approved", why };
}

function left(why: string): AutonomyVerdict {
  return { decision: "left", why };
}
