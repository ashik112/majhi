import { PAGE_PATH } from "@majhi/shared";
import { Navigate } from "@tanstack/react-router";
import { SetupView } from "@/features/setup/setup-view";
import { useSearchParam } from "@/pages/parts/url-state";

/** "Hub setup" page, rendered by the app shell inside the main area. Old `?section=skills` and `?section=mcp...` links go to Skills & MCP. */
export function SetupPage() {
  const [section] = useSearchParam("section");
  if (section === "skills") return <Navigate to={PAGE_PATH.skills} search={{}} replace />;
  if (section?.startsWith("mcp")) return <Navigate to={PAGE_PATH.skills} search={{ tab: "mcp" }} replace />;
  return <SetupView />;
}
