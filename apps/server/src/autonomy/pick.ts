import {
  type Authority,
  type AuthorityRow,
  type AutonomyMode,
  type AutonomyPick,
  PRIVATE,
} from "@majhi/shared";
import { askedWhy } from "../captain/levels.ts";
import { limitWord, type SizeOf, sizeProblem } from "./sizes.ts";

/**
 * The owner's pick rules for autonomous mode (PRV-74 follow-up, 5.18): the largest task size it may
 * start, the workspaces where the captain starts work, and the tasks marked Not for autonomous mode. Pure: the digest leaves out what
 * they exclude, and the service refuses the captain's calls that break them.
 */

/** An org's name for the lines, `Private` for tasks with no org. */
export type OrgNames = Readonly<Record<string, string>>;

export function orgName(org: string, names: OrgNames): string {
  return names[org] ?? (org === PRIVATE ? "Private" : org);
}

/**
 * Why the workspace's authority table (5.18) keeps the captain from this call, or undefined when a
 * row that governs it is "Captain decides". `rows` are the rows that govern the call; any one on
 * "Captain decides" is enough (a plain change to a task needs the captain to start work or do upkeep).
 */
export function authorityProblem(
  authority: Authority,
  mode: AutonomyMode,
  rows: readonly AuthorityRow[],
  org: string,
  names: OrgNames,
): string | undefined {
  const name = orgName(org, names);
  if (rows.some((r) => authority[r] === "decide")) {
    // Turning off: the mode's own refusal says why nothing new starts.
    if (mode !== "off") return undefined;
    return `Auto-pilot is off, so the captain does not start or change work in ${name}. It acts only when you ask`;
  }
  return rows[0] === undefined ? undefined : askedWhy(rows[0], name);
}

/** Why the rules leave a backlog task out, or undefined when the captain may take it. */
export function leftOutWhy(
  pick: AutonomyPick,
  task: { org?: string | undefined; noAutonomy?: boolean | undefined },
  size: SizeOf,
  names: OrgNames,
  authority: Authority,
): string | undefined {
  if (task.noAutonomy === true) return "Marked Not for Auto-pilot";
  if (authority.start !== "decide")
    return `In ${orgName(task.org ?? PRIVATE, names)} you decide when work starts`;
  const big = sizeProblem(pick.size, size);
  return big === undefined ? undefined : upperFirst(big);
}

/** The rules in one line each, for the digest of one workspace's lane. */
export function pickLines(pick: AutonomyPick, names: OrgNames, org?: string): string[] {
  return [
    `Task size: ${limitWord(pick.size)}${pick.size === "any" ? ". Take large tasks too, splitting them when that helps." : ". Larger tasks, and tasks whose size is not known, are not started."}`,
    org === undefined
      ? "Workspaces: only those where the captain decides when work starts, each in its own lane."
      : `Workspace: ${orgName(org, names)} only. This lane never sees or acts in another workspace.`,
    "Tasks the owner marked Not for Auto-pilot are left alone.",
  ];
}

function upperFirst(text: string): string {
  return text === "" ? text : text[0]?.toUpperCase() + text.slice(1);
}
