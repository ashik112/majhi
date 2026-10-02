import { type AgentEntry, DEFAULT_CHAT_TITLES, type OrgView, type TaskSummary } from "@majhi/shared";
import { type AgentGroup, entryId, groupAgents, INVALID_GROUP, type OkAgent } from "@/features/agents/model";

/** The name a chat shows: its title, or "New chat" until the first message names it. */
export function chatTitle(chat: Pick<TaskSummary, "title">): string {
  return DEFAULT_CHAT_TITLES.includes(chat.title) ? "New chat" : chat.title;
}

export interface ChatAgentRow {
  entry: OkAgent;
  id: string;
  chats: TaskSummary[];
  /** A chat of this agent waits for the owner. */
  asking: boolean;
}

export interface ChatGroup {
  group: AgentGroup;
  agents: ChatAgentRow[];
}

/**
 * Agents by org for the chat list: Root first with the captain on top, then each org. An org filter keeps
 * Root and that org. A search keeps the chats whose title matches, and the agents whose id does.
 */
export function chatGroups(input: {
  entries: readonly AgentEntry[];
  orgs: readonly OrgView[];
  chats: readonly TaskSummary[];
  org: string | undefined;
  query: string;
}): ChatGroup[] {
  const q = input.query.trim().toLowerCase();
  const byAgent = new Map<string, TaskSummary[]>();
  for (const chat of input.chats) {
    const lead = chat.team[0];
    if (lead === undefined) continue;
    byAgent.set(lead, [...(byAgent.get(lead) ?? []), chat]);
  }
  const out: ChatGroup[] = [];
  for (const group of groupAgents(input.entries, input.orgs)) {
    if (input.org !== undefined && group.scope !== "root" && group.scope !== input.org) continue;
    const agents: ChatAgentRow[] = [];
    for (const entry of group.entries) {
      if (entry.status !== "ok") continue;
      const id = entryId(entry);
      const all = byAgent.get(id) ?? [];
      const nameHit = q === "" || id.toLowerCase().includes(q);
      const chats = q === "" || nameHit ? all : all.filter((c) => chatTitle(c).toLowerCase().includes(q));
      if (q !== "" && !nameHit && chats.length === 0) continue;
      agents.push({ entry, id, chats, asking: all.some((c) => c.asking === true) });
    }
    if (agents.length > 0 || (q === "" && group.scope !== INVALID_GROUP)) out.push({ group, agents });
  }
  return out;
}
