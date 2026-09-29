import { createRootRoute, createRoute, createRouter, Link } from "@tanstack/react-router";
import { MapPinOff } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { HomeRoute } from "@/features/home/home-route";
import { EditRootsRoute } from "@/features/roots/edit-roots-route";

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

export const router = createRouter({
  routeTree: rootRoute.addChildren([homeRoute, editRootsRoute]),
  defaultPreload: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
