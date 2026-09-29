/** The path of every page, in one place: the router, the sidebar, the keys and the links between pages read it. */
export const PAGE_PATH = {
  board: "/",
  agents: "/agents",
  accounts: "/accounts",
  // Not `/health`: the server answers that address itself, so a reload there would show its JSON.
  usage: "/usage",
  skills: "/skills",
  setup: "/setup",
  projects: "/projects",
  orgs: "/orgs",
} as const;

export type PageName = keyof typeof PAGE_PATH;
export type PagePath = (typeof PAGE_PATH)[PageName];
