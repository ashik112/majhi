import { PAGE_PATH } from "@majhi/shared";
import { Navigate } from "@tanstack/react-router";
import { ConnectionsView } from "@/features/connections/connections-view";
import { useSearchParam } from "@/pages/parts/url-state";

/** "Connections" page, rendered by the app shell inside the main area. MCP servers moved to Skills & MCP. */
export function ConnectionsPage() {
  const [tab] = useSearchParam("tab");
  if (tab === "mcp") return <Navigate to={PAGE_PATH.skills} search={{ tab: "mcp" }} replace />;
  return <ConnectionsView />;
}
