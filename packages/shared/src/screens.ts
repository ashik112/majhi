/**
 * majhi's screens as plain data: the web app builds its Settings list and router paths
 * from it, and the captain's prompt carries the same map, so neither can name a page that is not there.
 */

/** The path of every page, in one place: the router, the keys and the links between pages read it. */
export const PAGE_PATH = {
  today: "/today",
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
  captain: "/captain",
  playbooks: "/playbooks",
  watch: "/watch",
  wiki: "/wiki",
  limits: "/limits",
  decisions: "/decisions",
} as const;

export type PageName = keyof typeof PAGE_PATH;
export type PagePath = (typeof PAGE_PATH)[PageName];

/** What each page is called in Settings, the palette and the shortcuts list. */
export const PAGE_LABEL: Record<PageName, string> = {
  today: "Today",
  board: "Console",
  chats: "Chat",
  captain: "Captain",
  playbooks: "Playbooks",
  watch: "Watch",
  wiki: "Wiki",
  limits: "Limits",
  decisions: "Decisions",
  agents: "Agents",
  accounts: "Accounts",
  connections: "Connections",
  projects: "Projects and links",
  skills: "Skills & MCP",
  memory: "Memory",
  orgs: "Workspaces",
  setup: "Hub setup",
  usage: "Health & usage",
  audit: "Audit log",
};

/** The name a page is called in a message ("Watch (/watch)"). The console is one screen with three panes. */
export function pageLabel(page: PageName): string {
  return page === "decisions" ? "Needs you" : PAGE_LABEL[page];
}

/** The sections of Hub setup, in list order, under their group. The URL keeps one as `?section=`. */
export const SETUP_GROUPS = [
  { label: "Basics", sections: ["overview", "roots", "ssh"] },
  {
    label: "How majhi works",
    sections: ["decisions", "memory", "wiki", "context", "turns", "approvals", "notifications", "containers"],
  },
  { label: "More", sections: ["editor", "appearance", "backups", "history"] },
] as const;

export type SetupSection = (typeof SETUP_GROUPS)[number]["sections"][number];

export const SETUP_SECTIONS: readonly SetupSection[] = SETUP_GROUPS.flatMap((g) => g.sections);

export const SECTION_TITLE: Record<SetupSection, string> = {
  overview: "Overview",
  roots: "Project folders",
  ssh: "SSH keys",
  decisions: "Laya",
  memory: "Memory",
  wiki: "Wiki",
  context: "Context and limits",
  turns: "Turns",
  approvals: "Approvals",
  notifications: "Notifications",
  editor: "Editor",
  containers: "Containers",
  appearance: "Appearance",
  backups: "Backups",
  history: "History",
};

export function isSetupSection(value: string | undefined): value is SetupSection {
  return SETUP_SECTIONS.some((s) => s === value);
}

/** One row of the Settings list: a page with its own address, or a section of Hub setup. */
export type SettingsItem =
  | { kind: "page"; page: SettingsPage }
  | { kind: "section"; section: SetupSection; label?: string };

/** The pages that open inside the Settings frame, besides Hub setup itself. */
export type SettingsPage = Extract<
  PageName,
  | "connections"
  | "projects"
  | "memory"
  | "limits"
  | "audit"
  | "accounts"
  | "usage"
  | "agents"
  | "skills"
  | "wiki"
  | "playbooks"
  | "orgs"
  | "watch"
  | "captain"
>;

/** The Settings list, in order. Pages keep their own address; Hub setup's sections are `/setup?section=`. */
export const SETTINGS_GROUPS: readonly { label: string; items: readonly SettingsItem[] }[] = [
  {
    label: "General",
    items: [
      { kind: "section", section: "overview" },
      { kind: "section", section: "appearance" },
      { kind: "section", section: "notifications" },
      { kind: "section", section: "editor" },
    ],
  },
  {
    label: "Workspaces",
    items: [
      { kind: "page", page: "orgs" },
      { kind: "page", page: "projects" },
      { kind: "page", page: "accounts" },
      { kind: "page", page: "connections" },
      { kind: "section", section: "roots" },
      { kind: "section", section: "ssh" },
    ],
  },
  {
    label: "Agents",
    items: [
      { kind: "page", page: "agents" },
      { kind: "page", page: "captain" },
      { kind: "page", page: "skills" },
      { kind: "page", page: "playbooks" },
      { kind: "page", page: "memory" },
      { kind: "section", section: "memory", label: "Memory rules" },
      { kind: "page", page: "wiki" },
      { kind: "section", section: "wiki", label: "Wiki settings" },
      { kind: "section", section: "turns" },
      { kind: "section", section: "context" },
    ],
  },
  {
    label: "Control",
    items: [
      { kind: "page", page: "limits" },
      { kind: "section", section: "approvals" },
      { kind: "section", section: "decisions" },
      { kind: "page", page: "watch" },
    ],
  },
  {
    label: "System",
    items: [
      { kind: "page", page: "usage" },
      { kind: "section", section: "containers" },
      { kind: "section", section: "backups" },
      { kind: "section", section: "history" },
      { kind: "page", page: "audit" },
    ],
  },
];

export function settingsItemLabel(item: SettingsItem): string {
  return item.kind === "page" ? PAGE_LABEL[item.page] : (item.label ?? SECTION_TITLE[item.section]);
}

/** Overview is Hub setup's own address; every other section adds `?section=`. */
export function settingsItemPath(item: SettingsItem): string {
  if (item.kind === "page") return PAGE_PATH[item.page];
  return item.section === "overview" ? PAGE_PATH.setup : `${PAGE_PATH.setup}?section=${item.section}`;
}

/** How a message names a page: its name and its address, like "Watch (/watch)". */
export function pageRef(page: PageName): string {
  return `${pageLabel(page)} (${PAGE_PATH[page]})`;
}

/**
 * Every screen, one line each: the console, then the Settings list, then the pages only the palette
 * (Cmd K, which lists every page) opens.
 */
export const SCREEN_MAP: string = (() => {
  const settingsPages = new Set<PageName>(["setup"]);
  const lines = [
    "Console (/) > Needs you, Work and Chat, side by side. The old addresses /decisions, /today and /chats open it",
    ...SETTINGS_GROUPS.flatMap((group) =>
      group.items.map((item) => {
        if (item.kind === "page") settingsPages.add(item.page);
        return `Settings > ${group.label} > ${settingsItemLabel(item)} (${settingsItemPath(item)})`;
      }),
    ),
  ];
  const placed = new Set<PageName>(["board", ...settingsPages]);
  const others = (Object.keys(PAGE_PATH) as PageName[]).filter((page) => !placed.has(page));
  return [...lines, ...others.map((page) => `Palette (Cmd K) > ${pageRef(page)}`)].join("\n");
})();
