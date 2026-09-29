import type { AgentEntry, Role } from "@majhi/shared";
import { useAgents } from "./studio-queries";

export interface AgentInfo {
  id: string;
  role: Role;
  account: string;
  model: string | undefined;
  scope: string;
  isBoss: boolean;
}

const cache = new WeakMap<AgentEntry[], ReadonlyMap<string, AgentInfo>>();

/** Agents by id, for avatars and labels. Rebuilt only when the agents list changes. */
export function indexAgents(entries: AgentEntry[]): ReadonlyMap<string, AgentInfo> {
  const hit = cache.get(entries);
  if (hit) return hit;
  const map = new Map<string, AgentInfo>();
  for (const entry of entries) {
    if (entry.status !== "ok") continue;
    const fm = entry.agent.frontmatter;
    map.set(fm.id, {
      id: fm.id,
      role: fm.role,
      account: fm.account,
      model: fm.model,
      scope: fm.scope,
      isBoss: entry.isBoss,
    });
  }
  cache.set(entries, map);
  return map;
}

const EMPTY: ReadonlyMap<string, AgentInfo> = new Map();

export function useAgentIndex(): ReadonlyMap<string, AgentInfo> {
  const data = useAgents().data;
  return data ? indexAgents(data) : EMPTY;
}
