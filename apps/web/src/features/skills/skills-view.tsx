import { Navigate } from "@tanstack/react-router";
import { PageHeader } from "@/components/ui/page-header";
import { PAGE_PATH } from "@/lib/pages";
import { useSearchParam } from "@/pages/parts/url-state";
import { SkillsTab } from "./skills-tab";

/** `/skills`: the skills agents can use. MCP servers are connections now; old `?tab=mcp` links go there. */
export function SkillsView() {
  const [tab] = useSearchParam("tab");
  if (tab === "mcp") return <Navigate to={PAGE_PATH.connections} search={{ tab: "mcp" }} replace />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Skills"
        subtitle="Instructions agents can follow, kept in ~/.majhi/skills. Install here, or send a link to an agent in a room. MCP servers are on the Connections page."
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto flex max-w-[960px] flex-col gap-4 pt-2">
          <SkillsTab />
        </div>
      </div>
    </div>
  );
}
