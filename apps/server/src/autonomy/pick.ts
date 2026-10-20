import { type Authority, type AuthorityRow, PRIVATE, type Task } from "@majhi/shared";
import { askedWhy } from "../captain/levels.ts";

/**
 * What Autonomous may take from the backlog (docs/briefs/captain.md). Pure: the digest leaves out what these rules
 * exclude, and the service refuses the captain's calls that break them. The rules are fixed, not settings:
 * only tasks the owner made or approved (never an idea), and only in a workspace whose level lets the captain
 * start work.
 */

/** An org's name for the lines, `Private` for tasks with no org. */
export type OrgNames = Readonly<Record<string, string>>;

export function orgName(org: string, names: OrgNames): string {
  return names[org] ?? (org === PRIVATE ? "Private" : org);
}

/**
 * Why the workspace's level (SPEC 5.18) keeps the captain from this call, or undefined when a row that governs it
 * is "Captain decides". `rows` are the rows that govern the call; any one on "Captain decides" is enough (a plain
 * change to a task needs the captain to start work or do upkeep). The Autonomous switch is not read here: it only
 * governs backlog work (`may.ts`).
 */
export function authorityProblem(
  authority: Authority,
  rows: readonly AuthorityRow[],
  org: string,
  names: OrgNames,
): string | undefined {
  if (rows.some((r) => authority[r] === "decide")) return undefined;
  return rows[0] === undefined ? undefined : askedWhy(rows[0], orgName(org, names));
}

/** Why the rules leave a backlog task out, or undefined when the captain may take it. */
export function leftOutWhy(
  task: Pick<Task, "idea" | "org">,
  names: OrgNames,
  authority: Authority,
): string | undefined {
  if (task.idea !== undefined) return "It is an idea: only the owner starts it";
  if (authority.start !== "decide")
    return `In ${orgName(task.org ?? PRIVATE, names)} you decide when work starts`;
  return undefined;
}

/** The rules in one line each, for the digest of one workspace's lane. */
export function pickLines(names: OrgNames, org?: string): string[] {
  return [
    "Tasks of any size. Take large tasks too, writing the steps into the plan when that helps. A task stops for the owner when it spends its budget (by size) or fails twice.",
    org === undefined
      ? "Workspaces: only those where the captain decides when work starts, each in its own lane."
      : `Workspace: ${orgName(org, names)} only. This lane never sees or acts in another workspace.`,
    "Ideas, the agents' and your own, are left alone: only the owner starts one.",
  ];
}
