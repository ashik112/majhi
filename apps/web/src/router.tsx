import { TaskIdSchema } from "@majhi/shared";
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
import { BoardScreen } from "@/features/board/board-screen";
import { ChatsScreen } from "@/features/chats/chats-screen";
import { EditRootsRoute } from "@/features/roots/edit-roots-route";
import { TaskScreen } from "@/features/task/task-screen";
import { PAGE_PATH } from "@/lib/pages";

/** Search params every page may carry: the org filter, and the agent or account a link points at. */
export interface AppSearch {
  org?: string;
  agent?: string;
  account?: string;
  /** On Connections: the connection shown. */
  connection?: string;
  /** On Agents: open the new-agent form in this group (root or an org id). */
  create?: string;
  /** A file of the open task, shown in the viewer drawer. */
  file?: string;
  /** A room item of the open task to scroll to, from a search match. */
  item?: string;
  /** A task shown in the task drawer, opened from a task id in a message. */
  task?: string;
  /** An agent shown in the agent drawer, opened from a mention in a message. */
  peek?: string;
  /** How the board shows tasks. The board is the default. */
  view?: "tree";
  /** On Memory: the project shown (or `global`), and its tab. */
  project?: string;
  tab?: string;
  /** On Captain: the workspace whose thread is shown. */
  thread?: string;
  /** On Hub setup: the section shown. */
  section?: string;
  /** On Decisions: the decision shown. */
  id?: string;
  /** On the audit log: the org, the task, the agent, the kinds (comma separated), the decision and the days. */
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
  const connection = text(search.connection);
  const create = text(search.create);
  const file = text(search.file);
  const task = TaskIdSchema.safeParse(search.task).data;
  const peek = text(search.peek);
  const item = text(search.item);
  const view = search.view === "tree" ? "tree" : undefined;
  const project = text(search.project);
  const tab = text(search.tab);
  const thread = text(search.thread);
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
    ...(view ? { view } : {}),
    ...(org ? { org } : {}),
    ...(agent ? { agent } : {}),
    ...(account ? { account } : {}),
    ...(connection ? { connection } : {}),
    ...(create ? { create } : {}),
    ...(file ? { file } : {}),
    ...(task ? { task } : {}),
    ...(peek ? { peek } : {}),
    ...(item ? { item } : {}),
    ...(project ? { project } : {}),
    ...(tab ? { tab } : {}),
    ...(thread ? { thread } : {}),
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
          <Link to="/">Go to the board</Link>
        </Button>
      </div>
    </Problem>
  ),
});

const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.board,
  component: BoardScreen,
});
const chatsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.chats,
  component: ChatsScreen,
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chats/$taskId",
  component: ChatsScreen,
});
const taskRoute = createRoute({ getParentRoute: () => rootRoute, path: "/t/$taskId", component: TaskScreen });

// Pages load on demand, so the main chunk holds only the shell, the board and the room.
const captainRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.captain,
  component: lazyRouteComponent(() => import("@/pages/captain-page"), "CaptainPage"),
});
const playbooksRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.playbooks,
  component: lazyRouteComponent(() => import("@/pages/playbooks-page"), "PlaybooksPage"),
});
const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.watch,
  component: lazyRouteComponent(() => import("@/pages/watch-page"), "WatchPage"),
});
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.agents,
  component: lazyRouteComponent(() => import("@/pages/agents-page"), "AgentsPage"),
});
const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.accounts,
  component: lazyRouteComponent(() => import("@/pages/accounts-page"), "AccountsPage"),
});
const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.usage,
  component: lazyRouteComponent(() => import("@/pages/health-page"), "HealthPage"),
});
const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.connections,
  component: lazyRouteComponent(() => import("@/pages/connections-page"), "ConnectionsPage"),
});
const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.audit,
  component: lazyRouteComponent(() => import("@/pages/audit-page"), "AuditPage"),
});
const skillsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.skills,
  component: lazyRouteComponent(() => import("@/pages/skills-page"), "SkillsPage"),
});
const memoryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.memory,
  component: lazyRouteComponent(() => import("@/pages/memory-page"), "MemoryPage"),
});
const automationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.automations,
  component: lazyRouteComponent(() => import("@/pages/automations-page"), "AutomationsPage"),
});
// The Autonomous page is part of the Captain page now: /autonomous lands there, and an old view opens its sheet.
const autonomousRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/autonomous",
  beforeLoad: ({ search }) => {
    throw redirect({
      to: PAGE_PATH.captain,
      search: search.tab === "rules" || search.tab === "log" ? { tab: search.tab } : {},
    });
  },
});
const limitsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.limits,
  component: lazyRouteComponent(() => import("@/pages/limits-page"), "LimitsPage"),
});
const todayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.today,
  component: lazyRouteComponent(() => import("@/pages/today-page"), "TodayPage"),
});
const decisionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.decisions,
  component: lazyRouteComponent(() => import("@/pages/decisions-page"), "DecisionsPage"),
});
const businessRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.business,
  component: lazyRouteComponent(() => import("@/pages/business-page"), "BusinessPage"),
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.setup,
  component: lazyRouteComponent(() => import("@/pages/setup-page"), "SetupPage"),
});
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.projects,
  component: lazyRouteComponent(() => import("@/pages/projects-page"), "ProjectsPage"),
});
const orgsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: PAGE_PATH.orgs,
  component: lazyRouteComponent(() => import("@/pages/orgs-page"), "OrgsPage"),
});

const editRootsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/roots",
  component: EditRootsRoute,
});

// Old addresses from the three-column design.
const reposRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos",
  beforeLoad: () => {
    throw redirect({ to: PAGE_PATH.projects });
  },
});
const studioIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  beforeLoad: () => {
    throw redirect({ to: PAGE_PATH.agents });
  },
});
const studioTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$tab",
  beforeLoad: ({ params, search }) => {
    if (params.tab === "accounts") {
      throw redirect({ to: PAGE_PATH.accounts, search: search.account ? { account: search.account } : {} });
    }
    throw redirect({ to: PAGE_PATH.agents, search: search.agent ? { agent: search.agent } : {} });
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    boardRoute,
    chatsRoute,
    chatRoute,
    taskRoute,
    agentsRoute,
    accountsRoute,
    connectionsRoute,
    healthRoute,
    auditRoute,
    skillsRoute,
    memoryRoute,
    automationsRoute,
    autonomousRoute,
    captainRoute,
    playbooksRoute,
    watchRoute,
    limitsRoute,
    todayRoute,
    decisionsRoute,
    businessRoute,
    setupRoute,
    projectsRoute,
    orgsRoute,
    editRootsRoute,
    reposRoute,
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
