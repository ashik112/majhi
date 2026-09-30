import type { Fact } from "@majhi/shared";
import { Search } from "lucide-react";
import * as m from "motion/react-m";
import { useDeferredValue, useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useFacts, useMemoryEvents, useMemorySearch } from "@/lib/memory-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import { AutoDecisions } from "./auto-decisions";
import { FactRow } from "./fact-row";
import { inFilter, type ScopeFilter, shownFact } from "./model";

/**
 * Memory in Studio (SPEC 3.3): search, scope filters, the facts with their actions, and the steps
 * curation took on its own, each with Undo. Facts that wait for the owner sit under Needs review.
 */
export function MemoryView() {
  const facts = useFacts();
  const events = useMemoryEvents({ limit: 100 });
  const orgs = useOrgs();
  const projects = useProjects();
  const [filter, setFilter] = useState<ScopeFilter>("all");
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const search = useMemorySearch(query);

  const orgNames = useMemo(() => new Map((orgs.data ?? []).map((o) => [o.id, o.name])), [orgs.data]);
  const projectOrgs = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.org])),
    [projects.data],
  );
  const byId = useMemo(() => new Map((facts.data ?? []).map((f) => [f.id, f])), [facts.data]);
  const shown = useMemo(() => (facts.data ?? []).filter(shownFact), [facts.data]);
  const searching = query.trim() !== "";

  const rows = useMemo(() => {
    const source: Fact[] = searching ? (search.data ?? []).map((h) => h.fact) : shown;
    const inScope = source.filter((f) => inFilter(f, filter, projectOrgs));
    // Search order is the ranking; the list puts what waits for the owner first, then pinned facts.
    if (searching) return inScope;
    return [...inScope].sort((a, b) => rank(a) - rank(b));
  }, [searching, search.data, shown, filter, projectOrgs]);

  const pending = shown.filter((f) => f.status === "pending").length;
  const tabs: { value: ScopeFilter; label: string; count: number; alert?: boolean }[] = [
    { value: "all", label: "All", count: shown.length },
    { value: "global", label: "Global", count: shown.filter((f) => f.scope === "global").length },
    ...(orgs.data ?? []).map((o) => ({
      value: `org:${o.id}` as const,
      label: o.name,
      count: shown.filter((f) => inFilter(f, `org:${o.id}`, projectOrgs)).length,
    })),
    { value: "review", label: "Needs review", count: pending, alert: pending > 0 },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        bottom
        title="Memory"
        subtitle="Short facts that tasks learn and later tasks get in their brief. Nothing is recalled until it is approved."
      >
        <div role="tablist" aria-label="Memory scope" className="flex gap-1">
          {tabs.map((tab) => {
            const selected = tab.value === filter;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setFilter(tab.value)}
                className={cn(
                  "relative flex h-11 cursor-pointer items-center gap-2 px-3 text-base font-medium transition-colors duration-150",
                  selected ? "text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {tab.label}
                <span
                  className={cn("font-mono text-xs tabular-nums", tab.alert ? "text-coral" : "text-fg-faint")}
                >
                  {tab.count}
                </span>
                {selected && (
                  <m.span
                    layoutId="memory-scope-underline"
                    aria-hidden="true"
                    className="absolute inset-x-0 -bottom-px h-0.5 bg-accent"
                    transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto scroll-fade">
        <div className="flex max-w-[920px] flex-col gap-5 px-8 pt-5 pb-8">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
            />
            <Input
              type="search"
              aria-label="Search memory"
              placeholder="Search facts by meaning or words"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="h-11 pl-9"
            />
          </div>

          {facts.isError && <p className="m-0 text-base text-red">{describeError(facts.error)}</p>}
          {search.isError && <p className="m-0 text-base text-red">{describeError(search.error)}</p>}
          {facts.isPending && <Skeleton className="h-20 w-full rounded-xl" />}
          {facts.data && (
            <section aria-label={searching ? "Search results" : "Facts"} className="flex flex-col gap-2">
              {searching && !search.isPending && (
                <p className="m-0 text-sm text-fg-faint">{plural(rows.length, "match")} among active facts</p>
              )}
              {rows.length === 0 && !(searching && search.isPending) ? (
                <p className="m-0 text-base text-fg-muted text-pretty">{emptyText(filter, searching)}</p>
              ) : (
                <ul aria-label="Facts" className="m-0 flex list-none flex-col gap-2 p-0">
                  {rows.map((fact) => (
                    <FactRow key={fact.id} fact={fact} orgNames={orgNames} />
                  ))}
                </ul>
              )}
            </section>
          )}

          <AutoDecisions events={events.data ?? []} facts={byId} error={events.error} />
        </div>
      </div>
    </div>
  );
}

/** Waiting facts first, then pinned ones. */
function rank(fact: Fact): number {
  return fact.status === "pending" ? 0 : fact.pinned ? 1 : 2;
}

function emptyText(filter: ScopeFilter, searching: boolean): string {
  if (searching) return "No active fact matches. Facts that wait for review are under Needs review.";
  if (filter === "review")
    return "Nothing waits for you. New facts that curation is not sure about show up here.";
  return "No facts here yet. Tasks propose them, and the Housekeeper reads each finished task.";
}
