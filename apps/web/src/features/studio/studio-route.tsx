import { getRouteApi, Navigate, useNavigate } from "@tanstack/react-router";
import { AccountsTab } from "@/features/accounts/accounts-tab";
import { AgentsTab } from "@/features/agents/agents-tab";
import { HomeRoute } from "@/features/home/home-route";
import { parseStudioTab } from "./model";
import { StudioOverlay } from "./studio-overlay";

const route = getRouteApi("/studio/$tab");

/** `/studio/agents` and `/studio/accounts`: the Studio dialog over the home screen. */
export function StudioRoute() {
  const { tab: rawTab } = route.useParams();
  const search = route.useSearch();
  const navigate = useNavigate();
  const tab = parseStudioTab(rawTab);

  if (!tab) return <Navigate to="/studio/$tab" params={{ tab: "agents" }} search={{}} replace />;

  return (
    <>
      <HomeRoute />
      <StudioOverlay tab={tab}>
        {tab === "agents" ? (
          <AgentsTab
            search={search}
            onSearch={(next) =>
              void navigate({ to: "/studio/$tab", params: { tab: "agents" }, search: next })
            }
          />
        ) : (
          <AccountsTab />
        )}
      </StudioOverlay>
    </>
  );
}
