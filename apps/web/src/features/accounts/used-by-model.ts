import type { AgentEntry, OrgView } from "@majhi/shared";
import { type AgentGroup, groupAgents, INVALID_GROUP, type OkAgent } from "../agents/model";

function accountOf(agent: OkAgent): string {
  return agent.agent.frontmatter.account;
}

function byBossThenId(a: OkAgent, b: OkAgent): number {
  const boss = Number(b.isBoss) - Number(a.isBoss);
  return boss !== 0 ? boss : a.agent.frontmatter.id.localeCompare(b.agent.frontmatter.id);
}

function validAgents(entries: readonly AgentEntry[]): OkAgent[] {
  return entries.filter((e): e is OkAgent => e.status === "ok");
}

/** Valid agents by the account they use, captain first then by id. Invalid files have no readable account. */
export function agentsByAccount(entries: readonly AgentEntry[]): Map<string, OkAgent[]> {
  const map = new Map<string, OkAgent[]>();
  for (const agent of validAgents(entries)) {
    const list = map.get(accountOf(agent)) ?? [];
    list.push(agent);
    map.set(accountOf(agent), list);
  }
  for (const list of map.values()) list.sort(byBossThenId);
  return map;
}

/** At most `max` chips, and how many more there are. */
export function chipSplit<T>(items: readonly T[], max = 3): { shown: T[]; more: number } {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

export interface UsedByGroup {
  scope: string;
  label: string;
  color?: string;
  agents: OkAgent[];
}

/** One account's agents grouped by scope: Root first, then each org. Empty groups are dropped. */
export function usedByGroups(agents: readonly OkAgent[], orgs: readonly OrgView[]): UsedByGroup[] {
  return groupAgents(agents, orgs)
    .filter((g: AgentGroup) => g.scope !== INVALID_GROUP && g.entries.length > 0)
    .map((g) => {
      const group: UsedByGroup = {
        scope: g.scope,
        label: g.label,
        agents: g.entries.filter((e): e is OkAgent => e.status === "ok"),
      };
      if (g.color) group.color = g.color;
      return group;
    });
}

export interface MissingAccount {
  account: string;
  agents: string[];
}

/** Account ids that agent files name but no account has, with the agents that name them. */
export function missingAccounts(
  entries: readonly AgentEntry[],
  accountIds: readonly string[],
): MissingAccount[] {
  const known = new Set(accountIds);
  const missing = new Map<string, string[]>();
  for (const [account, agents] of agentsByAccount(entries)) {
    if (known.has(account)) continue;
    missing.set(
      account,
      agents.map((a) => a.agent.frontmatter.id),
    );
  }
  return [...missing.entries()]
    .map(([account, agents]) => ({ account, agents }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

/** "Anywhere" or the org names, for the "can work in" line. */
export function whereLabel(where: readonly string[], orgs: readonly OrgView[]): string {
  if (where.includes("anywhere")) return "Anywhere";
  return where.map((w) => orgs.find((o) => o.id === w)?.name ?? w).join(", ");
}
