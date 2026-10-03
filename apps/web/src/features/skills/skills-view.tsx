import { PageHeader } from "@/components/ui/page-header";
import { useSearchParam } from "@/pages/parts/url-state";
import { McpTab } from "./mcp-tab";
import { PANEL_ID, type PageTab, PageTabs } from "./parts";
import { SkillsTab } from "./skills-tab";

/** `/skills`: Skills and MCP servers, two tabs kept in `?tab=` so a link opens the right one. */
export function SkillsView() {
  const [param, setParam] = useSearchParam("tab");
  const tab: PageTab = param === "mcp" ? "mcp" : "skills";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Skills & MCP"
        subtitle="What agents can use besides their own tools: skills in ~/.majhi/skills and MCP servers as connections. Install here, or send a link to an agent in a room."
        bottom
      >
        <PageTabs value={tab} onChange={(next) => setParam(next === "skills" ? undefined : next)} />
      </PageHeader>
      <div
        id={PANEL_ID}
        role="tabpanel"
        aria-labelledby={`skills-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-8"
      >
        <div className="mx-auto flex max-w-[960px] flex-col gap-4 pt-2">
          {tab === "mcp" ? <McpTab /> : <SkillsTab />}
        </div>
      </div>
    </div>
  );
}
