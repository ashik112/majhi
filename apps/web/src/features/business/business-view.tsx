import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListDetail } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { Segmented } from "@/components/ui/segmented";
import { useCrmList, useDeadlines, useKbList } from "@/lib/business-queries";
import type { AppSearch } from "@/router";
import { DeadlinesPane } from "./deadlines-pane";
import { KnowledgePane } from "./knowledge-pane";
import { useScopes } from "./parts";
import { PeoplePane } from "./people-pane";
import { VoicePane } from "./voice-pane";

const TABS = ["knowledge", "people", "deadlines", "voice"] as const;
type Tab = (typeof TABS)[number];

/**
 * Business (SPEC 5.19): what the captain draws on to run the business. Knowledge, People and Deadlines
 * are lists with the picked row on the right; Voice has one row per workspace. The tab is in the URL.
 */
export function BusinessView() {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const scopes = useScopes();
  const tab: Tab = TABS.find((t) => t === search.tab) ?? "knowledge";
  const kb = useKbList().data?.total;
  const people = useCrmList().data?.total;
  const open = useDeadlines().data?.deadlines.filter((d) => d.status === "open").length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Knowledge"
        subtitle="The facts, the voice, the people and the dates the captain works from. Nothing here leaves this machine."
      >
        <Segmented
          label="Knowledge section"
          value={tab}
          segments={[
            { value: "knowledge", label: "Knowledge", ...(kb === undefined ? {} : { count: kb }) },
            { value: "people", label: "People", ...(people === undefined ? {} : { count: people }) },
            { value: "deadlines", label: "Deadlines", ...(open === undefined ? {} : { count: open }) },
            { value: "voice", label: "Voice" },
          ]}
          onChange={(next) =>
            void navigate({
              to: ".",
              search: (prev: AppSearch): AppSearch => ({ ...prev, tab: next }),
              replace: true,
            })
          }
        />
      </PageHeader>
      <ListDetail>
        {tab === "knowledge" && <KnowledgePane scopes={scopes} />}
        {tab === "people" && <PeoplePane scopes={scopes} />}
        {tab === "deadlines" && <DeadlinesPane scopes={scopes} />}
        {tab === "voice" && <VoicePane scopes={scopes} />}
      </ListDetail>
    </div>
  );
}
