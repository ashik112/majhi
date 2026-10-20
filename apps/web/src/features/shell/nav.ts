import type { PageName } from "@majhi/shared";

/** More words that find a page in the palette. */
export const PAGE_KEYWORDS: Record<PageName, string> = {
  today: "brief morning agenda day plan review time watch what needs me",
  board:
    "console tasks home work needs you inbox decisions questions approvals answer chats conversations talk",
  chats: "conversations talk",
  captain: "boss chief of staff autonomous away log findings results upkeep",
  playbooks: "standing work packs upkeep goals outbound drafts gate cadence schedule timers uptime incidents",
  watch:
    "services uptime incidents down outage status ntfy phone push alerts escalation health certificate dns monitor",
  wiki: "architecture how it works components flows roles frontend backend queue database sources docs pages update stale",
  limits: "budget budgets spend cost daily weekly floors safety money raise",
  decisions: "inbox needs you waiting questions approvals ship recommend answer",
  agents: "team roles models",
  accounts: "sign in claude codex login",
  connections: "kubectl kubernetes ssh env keys",
  projects: "repos links branches",
  skills: "skills mcp servers tools install instructions",
  memory: "lessons facts briefs",
  orgs: "orgs organisations clients teams",
  setup: "settings preferences roots folders notifications",
  usage: "health checks tokens cost spend budgets",
  audit: "history who did what pushes merges",
};
