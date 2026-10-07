import type { AgentEntry, OrgView } from "@majhi/shared";
import { entryId, groupAgents } from "@/features/agents/model";

/** The agents a chat can start with, by workspace (Root first, the captain on top of each group). */
export function agentEntryOptions(
  entries: readonly AgentEntry[],
  orgs: readonly OrgView[],
): { id: string; group: string }[] {
  return groupAgents(entries, orgs).flatMap((group) =>
    group.entries.flatMap((entry) =>
      entry.status === "ok" ? [{ id: entryId(entry), group: group.label }] : [],
    ),
  );
}
