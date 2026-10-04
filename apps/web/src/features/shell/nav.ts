import type { PageName } from "../../lib/pages";

/** What each page is called in the sidebar, the palette and the shortcuts list. */
export const PAGE_LABEL: Record<PageName, string> = {
  today: "Today",
  board: "Board",
  chats: "Chats",
  captain: "Captain",
  playbooks: "Playbooks",
  watch: "Watch",
  limits: "Limits",
  decisions: "Decisions",
  business: "Business",
  agents: "Agents",
  accounts: "Accounts",
  connections: "Connections",
  projects: "Projects and links",
  skills: "Skills",
  memory: "Memory",
  automations: "Automations",
  orgs: "Workspaces",
  setup: "Hub setup",
  usage: "Health and usage",
  audit: "Audit log",
};

/** More words that find a page in the palette. */
export const PAGE_KEYWORDS: Record<PageName, string> = {
  today: "brief morning agenda day plan deadlines review time watch what needs me",
  board: "tasks home columns",
  chats: "conversations talk",
  captain: "boss chief of staff autonomous autopilot away rules log summary upkeep workspaces authority",
  playbooks: "standing work packs upkeep goals outbound drafts gate cadence schedule uptime incidents",
  watch:
    "services uptime incidents down outage status ntfy phone push alerts escalation health certificate dns monitor",
  limits: "budget budgets spend cost daily weekly floors safety money raise",
  business:
    "knowledge base facts voice style people crm contacts leads investors clients deadlines hackathon grant launch renewal",
  decisions: "inbox needs you waiting questions approvals ship recommend answer",
  agents: "team roles models",
  accounts: "sign in claude codex login",
  connections: "kubectl kubernetes mcp ssh env keys",
  projects: "repos links branches",
  skills: "install",
  memory: "lessons facts briefs",
  automations: "schedules triggers timers",
  orgs: "orgs organisations clients teams",
  setup: "settings preferences roots folders notifications",
  usage: "health checks tokens cost spend budgets",
  audit: "history who did what pushes merges",
};

/**
 * The sidebar under the daily rows (Board, Chats, Captain): the pages the owner sets up
 * once and tunes, then the ones opened rarely. Workspaces open from the switcher at the top.
 */
export const NAV_GROUPS: readonly { label: string; pages: readonly PageName[] }[] = [
  {
    label: "Setup",
    pages: ["agents", "accounts", "connections", "projects", "skills", "memory", "automations"],
  },
  { label: "System", pages: ["setup", "usage", "audit"] },
];
