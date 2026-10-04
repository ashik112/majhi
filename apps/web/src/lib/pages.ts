/** The path of every page, in one place: the router, the sidebar, the keys and the links between pages read it. */
export const PAGE_PATH = {
  board: "/",
  chats: "/chats",
  agents: "/agents",
  accounts: "/accounts",
  connections: "/connections",
  // Not `/health`: the server answers that address itself, so a reload there would show its JSON.
  usage: "/usage",
  audit: "/audit",
  skills: "/skills",
  memory: "/memory",
  setup: "/setup",
  projects: "/projects",
  orgs: "/orgs",
  automations: "/automations",
  captain: "/captain",
  playbooks: "/playbooks",
  limits: "/limits",
  decisions: "/decisions",
  business: "/business",
} as const;

export type PageName = keyof typeof PAGE_PATH;
export type PagePath = (typeof PAGE_PATH)[PageName];
