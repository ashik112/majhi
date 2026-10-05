import { type AccountStatus, type AgentFrontmatter, canWorkIn, type Role, type Task } from "@majhi/shared";

/** Account states where a new run would fail at once. `unknown` is allowed: the account has not been checked yet. */
const UNUSABLE: ReadonlySet<AccountStatus> = new Set(["needs-login", "at-limit", "unreachable"]);

const ROLE_RANK: Record<Role, number> = { Lead: 0, Builder: 1, Reviewer: 2, Tester: 2, Root: 2 };

export interface PickInput {
  agents: readonly AgentFrontmatter[];
  org: string | undefined;
  /** Agent id of the captain, when there is one. */
  boss: string | undefined;
  accountStatus: ReadonlyMap<string, AccountStatus>;
  /** Accounts a floor keeps new work off (under their 5-hour or weekly floor). */
  held?: ReadonlySet<string> | undefined;
}

/**
 * The default agent for a task with no @mention (DECISIONS): agents that can work in the
 * org on a usable account, Lead before Builder before the rest, the org's own before root
 * agents. A task without an org goes to the captain. An account under its floor counts as not
 * usable while another agent can take the task. Falls back to agents on accounts that are not
 * usable, so the owner sees why the run fails. Undefined when nobody can work there.
 */
export function pickDefaultAgent(input: PickInput): string | undefined {
  const { agents, org, boss } = input;
  if (org === undefined) {
    const bossAgent = agents.find((a) => a.id === boss && canWorkIn(a, undefined));
    if (bossAgent !== undefined) return bossAgent.id;
  }
  const able = agents.filter((a) => canWorkIn(a, org));
  const usable = able.filter((a) => !UNUSABLE.has(input.accountStatus.get(a.account) ?? "unknown"));
  const open = usable.filter((a) => input.held?.has(a.account) !== true);
  const pool = open.length > 0 ? open : usable.length > 0 ? usable : able;
  const ranked = [...pool].sort(
    (a, b) =>
      Number(b.scope === org) - Number(a.scope === org) ||
      ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return ranked[0]?.id;
}

/**
 * The role an agent shows in a task. The first of a lead-mode team is its lead whatever its file
 * says, so a builder swapped into the lead's place shows as the lead.
 */
export function roleIn(task: Pick<Task, "mode" | "team">, agent: string, role: Role): Role {
  return task.mode === "lead" && task.team[0] === agent && role !== "Root" ? "Lead" : role;
}
