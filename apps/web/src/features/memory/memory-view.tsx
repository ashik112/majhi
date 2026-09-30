import * as m from "motion/react-m";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";
import { useFacts, useThreads } from "@/lib/memory-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import { BriefView } from "./brief-view";
import { LessonsView } from "./lessons-view";
import { readStored, writeStored } from "./project-picker";
import { RecordsView } from "./records-view";
import { ThreadsView } from "./threads-view";

type MemoryTab = "brief" | "tasks" | "threads" | "lessons";
const TABS: readonly MemoryTab[] = ["brief", "tasks", "threads", "lessons"];
const TAB_KEY = "majhi.memory.tab";

function storedTab(): MemoryTab {
  const saved = readStored(TAB_KEY);
  return TABS.find((t) => t === saved) ?? "brief";
}

/**
 * Memory (SPEC 5.6): each project's living brief, the record of every finished task, what those
 * tasks left open, and the few lessons worth carrying. The tab is remembered in this browser.
 */
export function MemoryView() {
  const [tab, setTabState] = useState<MemoryTab>(storedTab);
  const setTab = (value: MemoryTab) => {
    setTabState(value);
    writeStored(TAB_KEY, value);
  };
  const orgs = useOrgs();
  const projects = useProjects();
  const facts = useFacts({ status: "pending" });
  const threads = useThreads({ status: "open" });

  const orgNames = useMemo(() => new Map((orgs.data ?? []).map((o) => [o.id, o.name])), [orgs.data]);
  const projectOrgs = useMemo(
    () => new Map((projects.data ?? []).map((p) => [p.id, p.org])),
    [projects.data],
  );
  const pending = facts.data?.length ?? 0;
  const tabs: { value: MemoryTab; label: string; count?: number; alert?: boolean }[] = [
    { value: "brief", label: "Brief" },
    { value: "tasks", label: "Tasks" },
    { value: "threads", label: "Threads", ...(threads.data ? { count: threads.data.length } : {}) },
    { value: "lessons", label: "Lessons", ...(pending > 0 ? { count: pending, alert: true } : {}) },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        bottom
        title="Memory"
        subtitle="What majhi remembers across tasks: each project's brief, what finished tasks did, what they left open, and a few hard-won lessons."
      >
        <div role="tablist" aria-label="Memory" className="flex gap-1">
          {tabs.map((t) => {
            const selected = t.value === tab;
            return (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(t.value)}
                className={cn(
                  "relative flex h-11 cursor-pointer items-center gap-2 px-3 text-base font-medium transition-colors duration-150",
                  selected ? "text-fg" : "text-fg-muted hover:text-fg",
                )}
              >
                {t.label}
                {t.count !== undefined && (
                  <span
                    className={cn("font-mono text-xs tabular-nums", t.alert ? "text-coral" : "text-fg-faint")}
                  >
                    {t.count}
                  </span>
                )}
                {selected && (
                  <m.span
                    layoutId="memory-tab-underline"
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
      <div className="min-h-0 flex-1 overflow-auto">
        <div role="tabpanel" className="flex max-w-[920px] flex-col gap-5 px-8 pt-5 pb-8">
          {tab === "brief" && <BriefView projects={projects.data} orgNames={orgNames} />}
          {tab === "tasks" && <RecordsView projects={projects.data} orgNames={orgNames} />}
          {tab === "threads" && <ThreadsView />}
          {tab === "lessons" && (
            <LessonsView orgs={orgs.data ?? []} orgNames={orgNames} projectOrgs={projectOrgs} />
          )}
        </div>
      </div>
    </div>
  );
}
