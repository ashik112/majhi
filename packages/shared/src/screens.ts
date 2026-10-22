/**
 * majhi's screens as plain data: the web app builds its top bar places, its Settings list and router
 * paths from it, and the captain's prompt carries the same map, so neither can name a page that is not there.
 */

/**
 * The path of every page, in one place: the router, the keys and the links between pages read it.
 * Places (Watch, Wiki, Usage) have their own address. Settings entries are `/settings/<entry>`; a page
 * that is a part of an entry (the Captain page inside Agents) shares its entry's address.
 */
export const PAGE_PATH = {
  today: "/today",
  board: "/",
  chats: "/chats",
  decisions: "/decisions",
  watch: "/watch",
  wiki: "/wiki",
  // Memory is the Wiki's second tab and the audit log is Usage's second tab (`PAGE_TAB`).
  memory: "/wiki",
  // Not `/health`: the server answers that address itself, so a reload there would show its JSON.
  usage: "/usage",
  audit: "/usage",
  setup: "/settings",
  orgs: "/settings/workspaces",
  projects: "/settings/projects",
  accounts: "/settings/accounts",
  git: "/settings/git",
  connections: "/settings/connections",
  agents: "/settings/agents",
  captain: "/settings/agents",
  approvals: "/settings/approvals",
  skills: "/settings/skills",
  playbooks: "/settings/playbooks",
  limits: "/settings/limits",
  look: "/settings/look",
  editor: "/settings/editor",
  laya: "/settings/local-model",
  system: "/settings/system",
} as const;

export type PageName = keyof typeof PAGE_PATH;
export type PagePath = (typeof PAGE_PATH)[PageName];

/** The tab a page opens on, for the pages that are a tab of another one. */
export const PAGE_TAB: Partial<Record<PageName, string>> = { memory: "memory", audit: "activity" };

/** Where a page opens: its address, and the tab when it is one. */
export function pageTarget(page: PageName): { to: PagePath; tab?: string } {
  const tab = PAGE_TAB[page];
  return tab === undefined ? { to: PAGE_PATH[page] } : { to: PAGE_PATH[page], tab };
}

/** What each page is called in Settings, the palette and the shortcuts list. */
export const PAGE_LABEL: Record<PageName, string> = {
  today: "Today",
  board: "Home",
  chats: "Chat",
  decisions: "Decisions",
  watch: "Watch",
  wiki: "Wiki",
  memory: "Memory",
  usage: "Usage",
  audit: "Activity",
  setup: "Settings",
  orgs: "Workspaces",
  projects: "Projects",
  accounts: "AI accounts",
  git: "Git and SSH",
  connections: "Connections",
  agents: "Agents",
  captain: "Captain",
  approvals: "Approvals",
  skills: "Skills and tools",
  playbooks: "Playbooks",
  limits: "Limits",
  look: "Look and alerts",
  editor: "Editor",
  laya: "Local model",
  system: "System",
};

/** The name a page is called in a message ("Watch (/watch)"). The console is one screen with three panes. */
export function pageLabel(page: PageName): string {
  return page === "decisions" ? "Needs you" : PAGE_LABEL[page];
}

/** The places in the top bar, after the boat mark: where the owner checks things daily. */
export const PLACES = ["board", "watch", "wiki", "usage"] as const satisfies readonly PageName[];
export type Place = (typeof PLACES)[number];

/** The tabs of the Wiki place and of the Usage place, in order. */
export const WIKI_TABS = [
  { id: "pages", label: "Pages" },
  { id: "memory", label: "Memory" },
] as const;
export const USAGE_TABS = [
  { id: "health", label: "Health and cost" },
  { id: "activity", label: "Activity" },
] as const;

/** The parts of Settings that were sections of Hub setup, each one panel of majhi.yaml. */
export const SETUP_SECTIONS = [
  "roots",
  "ssh",
  "decisions",
  "memory",
  "wiki",
  "context",
  "turns",
  "approvals",
  "notifications",
  "editor",
  "containers",
  "appearance",
  "backups",
  "history",
] as const;

export type SetupSection = (typeof SETUP_SECTIONS)[number];

export const SECTION_TITLE: Record<SetupSection, string> = {
  roots: "Project folders",
  ssh: "SSH keys",
  decisions: "Local model",
  memory: "Memory rules",
  wiki: "Wiki settings",
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

/**
 * One panel inside a Settings entry: an existing page, a section of Hub setup, or the git sign-ins of
 * every workspace. An entry that holds several shows them one after another, each under its heading.
 */
export type SettingsPart =
  | { kind: "page"; page: PageName; title: string }
  | { kind: "section"; section: SetupSection; title: string }
  | { kind: "git"; title: string };

/** One row of the Settings list. */
export interface SettingsEntry {
  /** The last part of its address: `/settings/<id>`. */
  id: string;
  label: string;
  page: PageName;
  parts: readonly SettingsPart[];
}

const page = (p: PageName, title: string): SettingsPart => ({ kind: "page", page: p, title });
const section = (s: SetupSection): SettingsPart => ({ kind: "section", section: s, title: SECTION_TITLE[s] });

/** The Settings list: 14 entries in 4 groups. Each entry's panels are today's pages and sections, unchanged. */
export const SETTINGS_GROUPS: readonly { label: string; entries: readonly SettingsEntry[] }[] = [
  {
    label: "Workspaces",
    entries: [
      { id: "workspaces", label: "Workspaces", page: "orgs", parts: [page("orgs", "Workspaces")] },
      {
        id: "projects",
        label: "Projects",
        page: "projects",
        parts: [page("projects", "Projects and links"), section("roots")],
      },
    ],
  },
  {
    label: "Sign-ins",
    entries: [
      { id: "accounts", label: "AI accounts", page: "accounts", parts: [page("accounts", "AI accounts")] },
      {
        id: "git",
        label: "Git and SSH",
        page: "git",
        parts: [section("ssh"), { kind: "git", title: "Git logins" }],
      },
      {
        id: "connections",
        label: "Connections",
        page: "connections",
        parts: [page("connections", "Connections")],
      },
    ],
  },
  {
    label: "Agents",
    entries: [
      {
        id: "agents",
        label: "Agents",
        page: "agents",
        parts: [page("agents", "Agents"), page("captain", "Captain")],
      },
      { id: "approvals", label: "Approvals", page: "approvals", parts: [section("approvals")] },
      {
        id: "skills",
        label: "Skills and tools",
        page: "skills",
        parts: [page("skills", "Skills and tools")],
      },
      { id: "playbooks", label: "Playbooks", page: "playbooks", parts: [page("playbooks", "Playbooks")] },
      {
        id: "limits",
        label: "Limits",
        page: "limits",
        parts: [section("turns"), section("context"), page("limits", "Limits")],
      },
    ],
  },
  {
    label: "App",
    entries: [
      {
        id: "look",
        label: "Look and alerts",
        page: "look",
        parts: [section("appearance"), section("notifications")],
      },
      { id: "editor", label: "Editor", page: "editor", parts: [section("editor")] },
      { id: "local-model", label: "Local model", page: "laya", parts: [section("decisions")] },
      {
        id: "system",
        label: "System",
        page: "system",
        parts: [section("containers"), section("backups"), section("history")],
      },
    ],
  },
];

export const SETTINGS_ENTRIES: readonly SettingsEntry[] = SETTINGS_GROUPS.flatMap((g) => g.entries);

export function settingsEntry(id: string | undefined): SettingsEntry | undefined {
  return SETTINGS_ENTRIES.find((e) => e.id === id);
}

export function settingsEntryPath(entry: SettingsEntry): string {
  return `${PAGE_PATH.setup}/${entry.id}`;
}

/** Where a Hub setup section lives now. `/setup?section=x` redirects here. */
export type SectionHome =
  | { to: "entry"; entry: string }
  | { to: "console" }
  | { to: "wiki"; search: { tab: "memory"; rules: true } | { tab: "pages"; settings: true } };

export const SECTION_HOME: Record<SetupSection | "overview" | "skills", SectionHome> = {
  overview: { to: "console" },
  roots: { to: "entry", entry: "projects" },
  ssh: { to: "entry", entry: "git" },
  decisions: { to: "entry", entry: "local-model" },
  memory: { to: "wiki", search: { tab: "memory", rules: true } },
  wiki: { to: "wiki", search: { tab: "pages", settings: true } },
  context: { to: "entry", entry: "limits" },
  turns: { to: "entry", entry: "limits" },
  approvals: { to: "entry", entry: "approvals" },
  notifications: { to: "entry", entry: "look" },
  editor: { to: "entry", entry: "editor" },
  containers: { to: "entry", entry: "system" },
  appearance: { to: "entry", entry: "look" },
  backups: { to: "entry", entry: "system" },
  history: { to: "entry", entry: "system" },
  skills: { to: "entry", entry: "skills" },
};

/** Where a link that names a Hub setup section (`captain`, `notifications`, `mcp`) opens now. */
export function sectionTarget(section: string): {
  to: PagePath;
  search?: { tab?: string; rules?: true; settings?: true };
} {
  if (section === "captain") return { to: PAGE_PATH.captain };
  if (section.startsWith("mcp")) return { to: PAGE_PATH.skills, search: { tab: "mcp" } };
  const key = section === "skills" || section === "overview" || isSetupSection(section) ? section : undefined;
  const home = key === undefined ? undefined : SECTION_HOME[key];
  if (home === undefined || home.to === "console") return { to: PAGE_PATH.board };
  if (home.to === "wiki") return { to: PAGE_PATH.wiki, search: home.search };
  const entry = settingsEntry(home.entry);
  return { to: PAGE_PATH[entry?.page ?? "orgs"] };
}

/** How a message names a page: its name and its address, like "Watch (/watch)". */
export function pageRef(page: PageName): string {
  const { to, tab } = pageTarget(page);
  return `${pageLabel(page)} (${to}${tab === undefined ? "" : `?tab=${tab}`})`;
}

/**
 * Every screen, one line each: Home, the places, then the Settings list, then the pages only the palette
 * (Cmd K, which lists every page) opens.
 */
export const SCREEN_MAP: string = (() => {
  const lines = [
    "Home (/) > Needs you, Work and Chat, side by side. The old addresses /decisions, /today and /chats open it",
    "Places (top bar) > Watch (/watch), Wiki (/wiki, tabs Pages and Memory), Usage (/usage, tabs Health and cost, and Activity)",
    ...SETTINGS_GROUPS.flatMap((group) =>
      group.entries.map(
        (entry) =>
          `Settings > ${group.label} > ${entry.label} (${settingsEntryPath(entry)})${
            entry.parts.length > 1 ? `: ${entry.parts.map((p) => p.title).join(", ")}` : ""
          }`,
      ),
    ),
    "Wiki > Memory > Rules button: who writes each task record, briefs and lessons. Wiki > Pages > Settings button: the wiki's own settings",
    "The old addresses /accounts, /agents, /captain, /orgs, /projects, /connections, /skills, /playbooks, /limits, /memory, /audit and /setup open the new place of the same thing",
  ];
  return lines.join("\n");
})();
