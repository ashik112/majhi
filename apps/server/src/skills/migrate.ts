import type { CommandMeta } from "@majhi/shared";
import type { SkillStore } from "./store.ts";

/** What the move needs of the agent service. */
export interface LegacySkillAgents {
  legacySkills(): Promise<{ id: string; skills: string[] }[]>;
  dropLegacySkills(ids: string[], command: string, meta: CommandMeta): Promise<void>;
}

/**
 * Agent files used to hold a `skills` list. The skills lock is now the only place that says who has
 * a skill, so each listed, installed skill becomes an opt-in for that agent (unless the agent opted
 * out, which always won) and the list is dropped from the file. The opt-ins are written first, so a
 * crash in between leaves files that are moved again next start. Returns how many agents moved.
 */
export async function migrateAgentSkills(
  deps: { agents: LegacySkillAgents; store: SkillStore },
  meta: CommandMeta,
): Promise<number> {
  const legacy = await deps.agents.legacySkills();
  if (legacy.length === 0) return 0;
  const installed = await deps.store.names();
  const wanted = installed.filter((name) => legacy.some((l) => l.skills.includes(name)));
  await deps.store.changeMany(wanted, (entry, name) => {
    const optOut = entry.optOut ?? [];
    const add = legacy.filter((l) => l.skills.includes(name) && !optOut.includes(l.id)).map((l) => l.id);
    return { ...entry, optIn: [...new Set([...(entry.optIn ?? []), ...add])].sort() };
  });
  await deps.agents.dropLegacySkills(
    legacy.map((l) => l.id),
    "skills.migrate",
    meta,
  );
  return legacy.length;
}
