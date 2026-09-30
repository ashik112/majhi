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
import { EditRootsRoute } from "@/features/roots/edit-roots-route";
import { TaskScreen } from "@/features/task/task-screen";
import { PAGE_PATH } from "@/lib/pages";

/** Search params every page may carry: the org filter, and the agent or account a link points at. */
export interface AppSearch {
  org?: string;
  agent?: string;
  account?: string;
  /** A file of the open task, shown in the viewer drawer. */
  file?: string;
  /** A task shown in the task drawer, opened from a task id in a message. */
  task?: string;
  /** An agent shown in the agent drawer, opened from a mention in a message. */
  peek?: string;
  /** How the board shows tasks. The board is the default. */
  view?: "tree";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function validateSearch(search: Record<string, unknown>): AppSearch {
  const org = text(search.org);
  const agent = text(search.agent);
  const account = text(search.account);
  const file = text(search.file);
  const task = TaskIdSchema.safeParse(search.task).data;
  const peek = text(search.peek);
  const view = search.view === "tree" ? "tree" : undefined;
  return {
    ...(view ? { view } : {}),
    ...(org ? { org } : {}),
    ...(agent ? { agent } : {}),
    ...(account ? { account } : {}),
    ...(file ? { file } : {}),
    ...(task ? { task } : {}),
    ...(peek ? { peek } : {}),
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
const taskRoute = createRoute({ getParentRoute: () => rootRoute, path: "/t/$taskId", component: TaskScreen });

// Pages load on demand, so the main chunk holds only the shell, the board and the room.
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
    taskRoute,
    agentsRoute,
    accountsRoute,
    healthRoute,
    skillsRoute,
    memoryRoute,
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
