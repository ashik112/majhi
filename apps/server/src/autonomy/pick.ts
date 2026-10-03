import { type AutonomyMode, type AutonomyPick, type CaptainLevel, LEVEL_LABEL, PRIVATE } from "@majhi/shared";
import { effectiveLevel } from "../captain/levels.ts";
import { limitWord, type SizeOf, sizeProblem } from "./sizes.ts";

/**
 * The owner's pick rules for autonomous mode (PRV-74 follow-up, 5.18): the largest task size it may
 * start, the workspaces set to "Runs it", and the tasks marked Not for autonomous mode. Pure: the digest leaves out what
 * they exclude, and the service refuses the captain's calls that break them.
 */

/** An org's name for the lines, `Private` for tasks with no org. */
export type OrgNames = Readonly<Record<string, string>>;

export function orgName(org: string, names: OrgNames): string {
  return names[org] ?? (org === PRIVATE ? "Private" : org);
}

/**
 * Why the workspace's choice (5.18) keeps the captain from starting or changing work there, or
 * undefined when it is set to "Runs it" and autonomous mode is on.
 */
export function levelProblem(
  level: CaptainLevel,
  mode: AutonomyMode,
  org: string,
  names: OrgNames,
): string | undefined {
  if (effectiveLevel(level, mode) === "runs") return undefined;
  const name = orgName(org, names);
  // Paused or stopping: the mode's own refusal says why nothing new starts.
  if (level === "runs" && mode !== "off") return undefined;
  if (level === "runs")
    return `autonomous mode is off, so the captain does not start or change work in ${name}`;
  return `${name} is set to ${LEVEL_LABEL[level]}, so the captain does not start or change work there`;
}

/** Why the rules leave a backlog task out, or undefined when the captain may take it. */
export function leftOutWhy(
  pick: AutonomyPick,
  task: { org?: string | undefined; noAutonomy?: boolean | undefined },
  size: SizeOf,
  names: OrgNames,
  level: CaptainLevel,
): string | undefined {
  if (task.noAutonomy === true) return "Marked Not for autonomous mode";
  if (level !== "runs") return `${orgName(task.org ?? PRIVATE, names)} is set to ${LEVEL_LABEL[level]}`;
  const big = sizeProblem(pick.size, size);
  return big === undefined ? undefined : upperFirst(big);
}

/** The rules in one line each, for the digest of one workspace's lane. */
export function pickLines(pick: AutonomyPick, names: OrgNames, org?: string): string[] {
  return [
    `Task size: ${limitWord(pick.size)}${pick.size === "any" ? ". Take large tasks too, splitting them when that helps." : ". Larger tasks, and tasks whose size is not known, are not started."}`,
    org === undefined
      ? "Workspaces: only those set to Runs it, each in its own lane."
      : `Workspace: ${orgName(org, names)} only. This lane never sees or acts in another workspace.`,
    "Tasks the owner marked Not for autonomous mode are left alone.",
  ];
}

function upperFirst(text: string): string {
  return text === "" ? text : text[0]?.toUpperCase() + text.slice(1);
}
