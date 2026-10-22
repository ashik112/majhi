import type { PageName } from "@majhi/shared";

/** More words that find a page in the palette. */
export const PAGE_KEYWORDS: Record<PageName, string> = {
  today: "brief morning agenda day plan review time watch what needs me",
  board:
    "console tasks home work needs you inbox decisions questions approvals answer chats conversations talk",
  chats: "conversations talk",
  decisions: "inbox needs you waiting questions approvals ship recommend answer",
  watch:
    "services uptime incidents down outage status ntfy phone push alerts escalation health certificate dns monitor",
  wiki: "architecture how it works components flows roles frontend backend queue database sources docs pages update stale",
  memory: "lessons facts briefs rules records threads",
  usage: "health checks tokens cost spend budgets",
  audit: "activity history who did what pushes merges audit log",
  setup: "settings preferences",
  orgs: "orgs organisations clients teams",
  projects: "repos links branches folders roots",
  accounts: "sign in claude codex login",
  git: "ssh keys git login github gitlab bitbucket",
  connections: "kubectl kubernetes ssh env keys",
  agents: "team roles models boss chief of staff captain autonomous away log findings results upkeep",
  captain: "boss chief of staff autonomous away log findings results upkeep",
  approvals: "permissions rules allow ask routine full",
  skills: "skills mcp servers tools install instructions",
  playbooks: "standing work packs upkeep goals outbound drafts gate cadence schedule timers uptime incidents",
  limits: "budget budgets spend cost daily weekly floors safety money raise turns context",
  look: "appearance theme mode density dark light notifications alerts desktop browser",
  editor: "vs code cursor open files",
  laya: "local model decisions small model",
  system: "containers backups history restore images docker",
};
