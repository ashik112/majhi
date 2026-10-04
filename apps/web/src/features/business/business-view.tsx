import { useNavigate, useSearch } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ListDetail } from "@/components/ui/list-detail";
import { useCrmList, useDeadlines, useKbList } from "@/lib/business-queries";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import type { AppSearch } from "@/router";
import { DeadlinesPane } from "./deadlines-pane";
import { KnowledgePane } from "./knowledge-pane";
import { useScopes } from "./parts";
import { PeoplePane } from "./people-pane";
import { VoicePane } from "./voice-pane";

const TABS = ["knowledge", "people", "deadlines", "voice"] as const;
type Tab = (typeof TABS)[number];

const LABEL: Record<Tab, string> = {
  knowledge: "Facts",
  people: "People",
  deadlines: "Deadlines",
  voice: "Voice",
};

/**
 * Business (SPEC 5.19): what the captain draws on to run the business. A rail picks Facts, People,
 * Deadlines or Voice; each is a list with the picked row on the right. The tab is in the URL.
 */
export function BusinessView() {
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const scopes = useScopes();
  const tab: Tab = TABS.find((t) => t === search.tab) ?? "knowledge";
  const kb = useKbList().data?.total;
  const people = useCrmList().data?.total;
  const open = useDeadlines().data?.deadlines.filter((d) => d.status === "open").length;
  const [newFact, setNewFact] = useState(0);
  const counts: Record<Tab, string | undefined> = {
    knowledge: kb?.toString(),
    people: people?.toString(),
    deadlines: open === undefined ? undefined : `${open} open`,
    voice: undefined,
  };
  const go = (next: Tab) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => ({ ...prev, tab: next }),
      replace: true,
    });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className={cn("mb-3 flex min-h-11 shrink-0 items-center gap-4 rounded-2xl px-4 py-2", GLASS)}>
        <h1 className="text-md leading-5 font-semibold text-fg">Knowledge</h1>
        {tab === "knowledge" && (
          <Button size="sm" className="ml-auto" onClick={() => setNewFact((n) => n + 1)}>
            <Plus aria-hidden="true" />
            New fact
          </Button>
        )}
      </header>
      <ListDetail>
        <nav
          aria-label="Knowledge section"
          className={cn("flex w-[176px] shrink-0 flex-col gap-0.5 self-stretch rounded-2xl p-2", GLASS)}
        >
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              aria-current={t === tab ? "page" : undefined}
              onClick={() => go(t)}
              className={cn(
                "flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-base font-medium text-fg-muted hover:bg-raised hover:text-fg",
                t === tab && "bg-selected text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]",
              )}
            >
              {LABEL[t]}
              {counts[t] !== undefined && (
                <span className="tnum ml-auto font-mono text-xs text-fg-faint">{counts[t]}</span>
              )}
            </button>
          ))}
        </nav>
        {tab === "knowledge" && <KnowledgePane scopes={scopes} newSignal={newFact} />}
        {tab === "people" && <PeoplePane scopes={scopes} />}
        {tab === "deadlines" && <DeadlinesPane scopes={scopes} />}
        {tab === "voice" && <VoicePane scopes={scopes} />}
      </ListDetail>
    </div>
  );
}
