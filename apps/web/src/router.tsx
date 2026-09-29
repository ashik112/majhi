import { createRootRoute, createRoute, createRouter, Link, redirect } from "@tanstack/react-router";
import { MapPinOff } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import type { AgentsSearch } from "@/features/agents/agents-tab";
import { HomeRoute } from "@/features/home/home-route";
import { EditRootsRoute } from "@/features/roots/edit-roots-route";
import { searchString } from "@/features/studio/model";
import { StudioRoute } from "@/features/studio/studio-route";

const rootRoute = createRootRoute({
  component: AppShell,
  notFoundComponent: () => (
    <Problem icon={<MapPinOff />} title="Nothing here" body="This address does not match any page in majhi.">
      <div>
        <Button asChild variant="secondary">
          <Link to="/">Go to repos</Link>
        </Button>
      </div>
    </Problem>
  ),
});

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomeRoute });

const editRootsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/roots",
  component: EditRootsRoute,
});

const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio/$tab",
  component: StudioRoute,
  validateSearch: (search: Record<string, unknown>): AgentsSearch => {
    const agent = searchString(search.agent);
    const account = searchString(search.account);
    return { ...(agent ? { agent } : {}), ...(account ? { account } : {}) };
  },
});

const studioIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  beforeLoad: () => {
    throw redirect({ to: "/studio/$tab", params: { tab: "agents" }, search: {} });
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, editRootsRoute, studioRoute, studioIndexRoute]),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
