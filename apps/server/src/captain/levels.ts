import {
  ALL_ASK,
  AUTHORITY_REFUSAL,
  type Authority,
  type AuthorityRow,
  type AutonomyMode,
  type AutonomyOrg,
  type AutonomySettings,
  type CaptainChore,
  CaptainChoreSchema,
  type CaptainLevel,
  PRIVATE,
} from "@majhi/shared";

/**
 * Who decides what in a workspace (SPEC 5.18). Pure: the authority table with its defaults, the move from
 * the old three levels, what holds while Autonomous is not On, which chores a table runs, and the move from
 * the old pick rule.
 */

/** Every row `decide` or `ask` as the table of the old three levels read (SPEC 5.18, "Moving today's settings"). */
function fromLevel(level: CaptainLevel, push: boolean, merge: boolean): Authority {
  if (level === "ask") return { ...ALL_ASK };
  if (level === "tidy") return { ...ALL_ASK, questions: "decide", approvals: "decide", upkeep: "decide" };
  return {
    start: "decide",
    questions: "decide",
    approvals: "decide",
    upkeep: "decide",
    merge: merge ? "decide" : "ask",
    push: push ? "decide" : "ask",
  };
}

/**
 * Who decides each row in a workspace, as saved. The saved `authority` wins. Without it the old
 * `level`, `push` and `merge` give it. With nothing saved: Private keeps things tidy, any other
 * workspace asks about everything except upkeep.
 */
export function authorityOf(settings: Pick<AutonomySettings, "orgs">, org: string): Authority {
  const own = settings.orgs[org];
  if (own?.authority !== undefined) return own.authority;
  if (own?.level !== undefined) return fromLevel(own.level, own.push === true, own.merge === true);
  const base: Authority =
    org === PRIVATE ? fromLevel("tidy", false, false) : { ...ALL_ASK, upkeep: "decide" };
  // No level was ever chosen, but the owner may have switched merging or pushing on: keep that.
  return {
    ...base,
    ...(own?.merge === true ? { merge: "decide" as const } : {}),
    ...(own?.push === true ? { push: "decide" as const } : {}),
  };
}

/**
 * What the captain may do now. Autonomous is the single place that decides it: while it is not On,
 * every row behaves as "Ask me", whatever a workspace is set to.
 */
export function effectiveAuthority(authority: Authority, mode: AutonomyMode): Authority {
  return mode === "on" ? authority : { ...ALL_ASK };
}

/** The saved form after a change to some rows: the rows from `authorityOf`, with the change on top. */
export function withAuthority(current: Authority, change: Partial<Authority>): Authority {
  return { ...current, ...change };
}

/**
 * The chores the captain runs. Each follows the row that governs it: cards `approvals`, questions
 * `questions`, the rest `upkeep`. Shipping runs when the captain merges or does upkeep: with merge on
 * "Ask me" it only hands the owner a ready-to-ship card.
 */
export function choresOf(authority: Authority): readonly CaptainChore[] {
  return CaptainChoreSchema.options.filter((chore) => {
    switch (chore) {
      case "cards":
        return authority.approvals === "decide";
      case "questions":
        return authority.questions === "decide";
      case "ship":
        return authority.merge === "decide" || authority.upkeep === "decide";
      default:
        return authority.upkeep === "decide";
    }
  });
}

/** The authority row that governs a command that ships work. The others need no row here. */
export const SHIP_ROW: Readonly<Record<string, "merge" | "push">> = {
  "tasks.merge": "merge",
  "tasks.mergeMrs": "merge",
  "tasks.markMerged": "merge",
  "tasks.resolveShip": "merge",
  "tasks.push": "push",
  "tasks.openMrs": "push",
};

/** The refusal line when a row is "Ask me": "Refused: in Acme you decide when work starts, ...". */
export function askedWhy(row: AuthorityRow, name: string): string {
  return `in ${name} you decide ${AUTHORITY_REFUSAL[row]}`;
}

/** The same line to start a sentence: "In Acme you decide when work starts, so ...". */
export function askedSentence(row: AuthorityRow, name: string): string {
  const line = askedWhy(row, name);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** The workspaces the captain knows: Private, then each org of majhi.yaml. */
export function workspaceIds(orgs: Readonly<Record<string, unknown>>): string[] {
  return [PRIVATE, ...Object.keys(orgs).filter((id) => id !== PRIVATE)];
}

/**
 * The move from the pick rule "workspaces it may work in" (before Phase 13) to the per-workspace
 * choice: each listed workspace becomes "Runs it" unless it already has a choice, and the list goes.
 * Undefined when there is nothing to move. The other workspaces keep their default.
 */
export function migratePickOrgs(
  autonomy: Pick<AutonomySettings, "orgs" | "pick">,
): { orgs: Record<string, AutonomyOrg>; pick: Omit<AutonomySettings["pick"], "orgs"> } | undefined {
  const listed = autonomy.pick.orgs;
  if (listed === undefined) return undefined;
  const orgs: Record<string, AutonomyOrg> = { ...autonomy.orgs };
  for (const id of new Set(listed)) {
    const had = orgs[id] ?? {};
    if (had.level === undefined && had.authority === undefined) orgs[id] = { ...had, level: "runs" };
  }
  return { orgs, pick: { size: autonomy.pick.size } };
}
