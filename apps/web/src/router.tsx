import {
  isSetupSection,
  PAGE_PATH,
  SECTION_HOME,
  SETTINGS_ENTRIES,
  settingsEntry,
  TaskIdSchema,
} from "@majhi/shared";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  lazyRouteComponent,
  redirect,
} from "@tanstack/react-router";
import { MapPinOff } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { ConsoleScreen } from "@/features/console/console-screen";

/** Search params every page may carry: the org filter, and the agent or account a link points at. */
export interface AppSearch {
  org?: string;
  agent?: string;
  account?: string;
  /** On Accounts: with `account`, start its sign-in at once (when it is signed out). */
  signin?: "start";
  /** On Connections: the connection shown. */
  connection?: string;
  /** On Agents: open the new-agent form in this group (root or an org id). */
  create?: string;
  /** A file of the open task, shown in the viewer drawer. */
  file?: string;
  /** The task whose file `file` is, when the viewer opens on another page (the Captain page, Chats). */
  fileTask?: string;
  /** A line of `file` the viewer opens at (a hand-off check's log opens where its failure begins). */
  fileLine?: number;
  /** A room item of the open task to scroll to, from a search match. */
  item?: string;
  /** A task shown in the task drawer, opened from a task id in a message. */
  task?: string;
  /** An agent shown in the agent drawer, opened from a mention in a message. */
  peek?: string;
  /** On the console: the chat to open (`captain`, or a conversation id) and the pane to focus. */
  chat?: string;
  pane?: "needs" | "work";
  /** On Skills: the skill whose detail opens. */
  skill?: string;
  /** On the Wiki place: open the Memory rules dialog, or the Wiki settings dialog. */
  rules?: true;
  settings?: true;
  /** On Memory (the Wiki place, tab Memory): its own tab (brief, tasks, threads, lessons). */
  mtab?: string;
  /** On Memory: the project shown (or `global`), and its tab. */
  project?: string;
  tab?: string;
  /** On Captain: the workspace whose thread is shown. */
  thread?: string;
  /** On Captain, with `thread`: show that workspace's Urgent thread. */
  urgent?: true;
  /** On Hub setup: the section shown. */
  section?: string;
  /** On Decisions: the decision shown. */
  id?: string;
  /** On the audit log: the org, the task, the agent, the kinds (comma separated), the decision and the days. On the Wiki: `workspace` shows the whole workspace instead of a project. */
  scope?: string;
  about?: string;
  who?: string;
  kinds?: string;
  decision?: string;
  from?: string;
  to?: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  const org = text(search.org);
  const agent = text(search.agent);
  const account = text(search.account);
  const signin = search.signin === "start" ? "start" : undefined;
  const connection = text(search.connection);
  const create = text(search.create);
  const file = text(search.file);
  const fileTask = TaskIdSchema.safeParse(search.fileTask).data;
  const lineNumber = Number(search.fileLine);
  const fileLine = Number.isInteger(lineNumber) && lineNumber > 0 ? lineNumber : undefined;
  const task = TaskIdSchema.safeParse(search.task).data;
  const peek = text(search.peek);
  const item = text(search.item);
  const chat = text(search.chat);
  const pane = search.pane === "needs" || search.pane === "work" ? search.pane : undefined;
  const skill = text(search.skill);
  const project = text(search.project);
  const tab = text(search.tab);
  const mtab = text(search.mtab);
  const rules = search.rules === true || search.rules === "true" ? true : undefined;
  const settings = search.settings === true || search.settings === "true" ? true : undefined;
  const thread = text(search.thread);
  const urgent = (thread && search.urgent === true) || search.urgent === "true" ? true : undefined;
  const section = text(search.section);
  const scope = text(search.scope);
  const about = text(search.about);
  const who = text(search.who);
  const kinds = text(search.kinds);
  const decision = text(search.decision);
  const id = text(search.id);
  const from = text(search.from);
  const to = text(search.to);
  return {
    ...(chat ? { chat } : {}),
    ...(pane ? { pane } : {}),
    ...(org ? { org } : {}),
    ...(agent ? { agent } : {}),
    ...(account ? { account } : {}),
    ...(account && signin ? { signin } : {}),
    ...(connection ? { connection } : {}),
    ...(create ? { create } : {}),
    ...(file ? { file } : {}),
    ...(file && fileTask ? { fileTask } : {}),
    ...(file && fileLine ? { fileLine } : {}),
    ...(task ? { task } : {}),
    ...(peek ? { peek } : {}),
    ...(item ? { item } : {}),
    ...(skill ? { skill } : {}),
    ...(project ? { project } : {}),
    ...(tab ? { tab } : {}),
    ...(mtab ? { mtab } : {}),
    ...(rules ? { rules } : {}),
    ...(settings ? { settings } : {}),
    ...(thread ? { thread } : {}),
    ...(urgent ? { urgent } : {}),
    ...(section ? { section } : {}),
    ...(scope ? { scope } : {}),
    ...(about ? { about } : {}),
    ...(who ? { who } : {}),
    ...(kinds ? { kinds } : {}),
    ...(decision ? { decision } : {}),
    ...(id ? { id } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

const rootRoute = createRootRoute({
  component: AppShell,
  validateSearch,
  notFoundComponent: () => (
    <Problem icon={<MapPinOff />} title="Nothing here" body="This address does not match any page in majhi.">
      <div>
        <Button asChild variant="secondary">
          <Link to="/">Go to the console</Link>
        </Button>
      </div>
    </Problem>
  ),
});

// The console is Needs you, Work and Chat on one screen; it is the first thing the app loads.
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.board,
  component: ConsoleScreen,
});
// Old addresses: Today, Decisions and Chats are the console now. A decision or a chat they named is
// selected there.
const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.chats,
  beforeLoad: () => {
    throw redirect({ to: PAGE_PATH.board });
  },
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chats/$taskId",
  beforeLoad: ({ params }) => {
    throw redirect({ to: PAGE_PATH.board, search: { chat: params.taskId } });
  },
});
const taskRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/t/$taskId",
  component: lazyRouteComponent(() => import("@/features/task/task-screen"), "TaskScreen"),
});

// Pages, the task screen and chats load on demand, so the main chunk holds only the shell and the board.
// The places in the top bar.
const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.watch,
  component: lazyRouteComponent(() => import("@/pages/watch-page"), "WatchPage"),
});
const wikiRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.wiki,
  component: lazyRouteComponent(() => import("@/pages/wiki-page"), "WikiPage"),
});
const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.usage,
  component: lazyRouteComponent(() => import("@/pages/usage-page"), "UsagePage"),
});

const FIRST_ENTRY = SETTINGS_ENTRIES[0]?.id ?? "workspaces";

// Settings: 14 entries, one address each. `/settings` opens the first.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.setup,
  beforeLoad: ({ search }) => {
    throw toEntry(FIRST_ENTRY, search);
  },
});
const SettingsPage = lazyRouteComponent(() => import("@/pages/settings-page"), "SettingsPage");
const entryRoute = <const P extends string>(path: P) =>
  createRoute({ getParentRoute: () => rootRoute, path, component: SettingsPage });
const entryRoutes = [
  entryRoute(PAGE_PATH.orgs),
  entryRoute(PAGE_PATH.projects),
  entryRoute(PAGE_PATH.accounts),
  entryRoute(PAGE_PATH.git),
  entryRoute(PAGE_PATH.connections),
  entryRoute(PAGE_PATH.agents),
  entryRoute(PAGE_PATH.approvals),
  entryRoute(PAGE_PATH.skills),
  entryRoute(PAGE_PATH.playbooks),
  entryRoute(PAGE_PATH.limits),
  entryRoute(PAGE_PATH.look),
  entryRoute(PAGE_PATH.editor),
  entryRoute(PAGE_PATH.laya),
  entryRoute(PAGE_PATH.system),
];

// Old addresses. Each one opens the new place of the same thing and keeps its search params.
function toEntry(id: string, search: AppSearch) {
  const entry = settingsEntry(id) ?? SETTINGS_ENTRIES[0];
  return redirect({ to: PAGE_PATH[entry?.page ?? "orgs"], search, replace: true });
}
const legacy = (path: string, entry: string) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: ({ search }) => {
      throw toEntry(entry, search);
    },
  });
const accountsRoute = legacy("/accounts", "accounts");
const agentsRoute = legacy("/agents", "agents");
const captainRoute = legacy("/captain", "agents");
const orgsRoute = legacy("/orgs", "workspaces");
const projectsRoute = legacy("/projects", "projects");
const skillsRoute = legacy("/skills", "skills");
const playbooksRoute = legacy("/playbooks", "playbooks");
const limitsRoute = legacy("/limits", "limits");
// Automations were folded into Playbooks (schedules) and Watch (triggers): old links land on Playbooks.
const automationsRoute = legacy("/automations", "playbooks");
const reposRoute = legacy("/repos", "projects");
const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  beforeLoad: ({ search }) => {
    // MCP servers moved to Skills and tools.
    throw toEntry(search.tab === "mcp" ? "skills" : "connections", search);
  },
});
// Memory is the Wiki's second tab. Its own tab (brief, tasks, threads, lessons) is `mtab` there.
const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory",
  beforeLoad: ({ search }) => {
    const { tab, ...rest } = search;
    throw redirect({
      to: PAGE_PATH.wiki,
      search: { ...rest, tab: "memory", ...(tab ? { mtab: tab } : {}) },
      replace: true,
    });
  },
});
// The audit log is Usage's second tab; its filters stay in the address.
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/audit",
  beforeLoad: ({ search }) => {
    throw redirect({ to: PAGE_PATH.usage, search: { ...search, tab: "activity" }, replace: true });
  },
});
// Hub setup's sections went to the entry (or the place) that holds them.
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  beforeLoad: ({ search }) => {
    const { section, ...rest } = search;
    const mcp = section?.startsWith("mcp") === true;
    const key = mcp ? "skills" : section;
    const home =
      key === "skills" || key === "overview" || isSetupSection(key) ? SECTION_HOME[key] : undefined;
    if (home === undefined) throw toEntry(FIRST_ENTRY, rest);
    if (home.to === "console") throw redirect({ to: PAGE_PATH.board, search: rest, replace: true });
    if (home.to === "wiki") {
      throw redirect({ to: PAGE_PATH.wiki, search: { ...rest, ...home.search }, replace: true });
    }
    throw toEntry(home.entry, mcp ? { ...rest, tab: "mcp" } : rest);
  },
});
const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.today,
  beforeLoad: () => {
    throw redirect({ to: PAGE_PATH.board });
  },
});
const decisionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.decisions,
  beforeLoad: ({ search }) => {
    throw redirect({ to: PAGE_PATH.board, search: search.id === undefined ? {} : { id: search.id } });
  },
});

const editRootsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/roots",
  component: lazyRouteComponent(() => import("@/features/roots/edit-roots-route"), "EditRootsRoute"),
});

// Old addresses from the three-column design.
const studioIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  beforeLoad: () => {
    throw toEntry("agents", {});
  },
});
const studioTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$tab",
  beforeLoad: ({ params, search }) => {
    if (params.tab === "accounts") {
      throw toEntry("accounts", search.account ? { account: search.account } : {});
    }
    throw toEntry("agents", search.agent ? { agent: search.agent } : {});
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    boardRoute,
    chatsRoute,
    chatRoute,
    taskRoute,
    watchRoute,
    wikiRoute,
    usageRoute,
    settingsRoute,
    ...entryRoutes,
    editRootsRoute,
    accountsRoute,
    agentsRoute,
    captainRoute,
    orgsRoute,
    projectsRoute,
    skillsRoute,
    playbooksRoute,
    limitsRoute,
    automationsRoute,
    reposRoute,
    connectionsRoute,
    memoryRoute,
    auditRoute,
    setupRoute,
    todayRoute,
    decisionsRoute,
    studioIndexRoute,
    studioTabRoute,
  ]),
  defaultPreload: "intent",
  defaultPreloadStaleTime: 30_000,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
