import type { PageName } from "../../lib/pages";

/** What each page is called in the sidebar, the palette and the shortcuts list. */
export const PAGE_LABEL: Record<PageName, string> = {
  today: "Today",
  board: "Home",
  chats: "Chats",
  captain: "Captain",
  playbooks: "Playbooks",
  watch: "Watch",
  limits: "Limits",
  decisions: "Decisions",
  business: "Knowledge",
  agents: "Agents",
  accounts: "Accounts",
  connections: "Connections",
  projects: "Projects and links",
  skills: "Skills",
  memory: "Memory",
  orgs: "Workspaces",
  setup: "Hub setup",
  usage: "Health & usage",
  audit: "Audit log",
};

/** More words that find a page in the palette. */
export const PAGE_KEYWORDS: Record<PageName, string> = {
  today: "brief morning agenda day plan deadlines review time watch what needs me",
  board: "tasks home columns",
  chats: "conversations talk",
  captain: "boss chief of staff autonomous autopilot away rules log summary upkeep workspaces authority",
  playbooks: "standing work packs upkeep goals outbound drafts gate cadence schedule timers uptime incidents",
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
  orgs: "orgs organisations clients teams",
  setup: "settings preferences roots folders notifications",
  usage: "health checks tokens cost spend budgets",
  audit: "history who did what pushes merges",
};

/**
 * The pages behind the sidebar's Settings menu: configuration only, set up once and tuned now and then.
 * Daily work, the team (Agents, Accounts) and Health & usage keep their own rows. Workspaces open from
 * the switcher at the top. Backups is a section of Hub setup.
 */
export const SETTINGS_PAGES: readonly PageName[] = [
  "connections",
  "projects",
  "skills",
  "memory",
  "limits",
  "setup",
  "audit",
];
