import type { PageName } from "../../lib/pages";

/** What each page is called in the sidebar, the palette and the shortcuts list. */
export const PAGE_LABEL: Record<PageName, string> = {
  board: "Board",
  chats: "Chats",
  autonomous: "Autonomous",
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
  board: "tasks home columns",
  chats: "conversations talk",
  autonomous: "autonomy autopilot away",
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
 * The sidebar under the daily rows (Board, Chats, Boss, Autonomous): the pages the owner sets up
 * once and tunes, then the ones opened rarely. Workspaces open from the switcher at the top.
 */
export const NAV_GROUPS: readonly { label: string; pages: readonly PageName[] }[] = [
  {
    label: "Setup",
    pages: ["agents", "accounts", "connections", "projects", "skills", "memory", "automations"],
  },
  { label: "System", pages: ["setup", "usage", "audit"] },
];
