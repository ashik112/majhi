import { type AutonomyPick, PRIVATE } from "@majhi/shared";
import { limitWord, type SizeOf, sizeProblem } from "./sizes.ts";

/**
 * The owner's pick rules for autonomous mode (PRV-74 follow-up): the largest task size it may start,
 * the orgs it works in, and the tasks marked Not for autonomous mode. Pure: the digest leaves out what
 * they exclude, and the service refuses the captain's calls that break them.
 */

/** An org's name for the lines, `Private` for tasks with no org. */
export type OrgNames = Readonly<Record<string, string>>;

export function orgName(org: string, names: OrgNames): string {
  return names[org] ?? (org === PRIVATE ? "Private" : org);
}

/** Why the org rule keeps autonomous mode out of this org, or undefined when it may work there. */
export function orgProblem(pick: AutonomyPick, org: string, names: OrgNames): string | undefined {
  if (pick.orgs === undefined || pick.orgs.includes(org)) return undefined;
  return `${orgName(org, names)} is not one of the workspaces autonomous mode may work in`;
}

/** Why the rules leave a backlog task out, or undefined when the captain may take it. */
export function leftOutWhy(
  pick: AutonomyPick,
  task: { org?: string | undefined; noAutonomy?: boolean | undefined },
  size: SizeOf,
  names: OrgNames,
): string | undefined {
  if (task.noAutonomy === true) return "Marked Not for autonomous mode";
  const org = orgProblem(pick, task.org ?? PRIVATE, names);
  if (org !== undefined) return upperFirst(org);
  const big = sizeProblem(pick.size, size);
  return big === undefined ? undefined : upperFirst(big);
}

/** The rules in one line each, for the digest and the captain. */
export function pickLines(pick: AutonomyPick, names: OrgNames): string[] {
  const orgs =
    pick.orgs === undefined
      ? "every workspace"
      : pick.orgs.length === 0
        ? "no workspace at all"
        : `only ${pick.orgs.map((o) => orgName(o, names)).join(", ")}`;
  return [
    `Task size: ${limitWord(pick.size)}${pick.size === "any" ? ". Take large tasks too, splitting them when that helps." : ". Larger tasks, and tasks whose size is not known, are not started."}`,
    `Workspaces (orgs): ${orgs}.`,
    "Tasks the owner marked Not for autonomous mode are left alone.",
  ];
}

function upperFirst(text: string): string {
  return text === "" ? text : text[0]?.toUpperCase() + text.slice(1);
}
