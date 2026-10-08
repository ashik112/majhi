import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { ListDetail, ListPane } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { describeError } from "@/lib/errors";
import { useFacts, useTaskRecords, useThreads } from "@/lib/memory-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import type { AppSearch } from "@/router";
import { MemoryDetail } from "./memory-detail";
import { MemoryList } from "./memory-list";
import { GLOBAL, MEMORY_TABS, type MemoryTab, memoryCounts } from "./model";
import { MemoryReviewActions } from "./review-actions";
import { readStored, writeStored } from "./storage";

const PROJECT_KEY = "majhi.memory.project";

/** Record counts in the list cover the newest this many records: the most `memory.records` gives. */
const RECORDS = 200;

/**
 * Memory (SPEC 5.6) as list and detail: every project by org, plus a Global row, each with what
 * memory holds for it; the picked one on the right with its brief, task records, threads and
 * lessons. The URL keeps the project and tab (`?project=&tab=`), so a link can open a review.
 */
export function MemoryView() {
  const orgs = useOrgs();
  const projects = useProjects();
  const facts = useFacts();
  const threads = useThreads();
  const records = useTaskRecords({ limit: RECORDS });
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();

  const projectList = projects.data ?? [];
  const projectOrgs = useMemo(() => new Map(projectList.map((p) => [p.id, p.org])), [projectList]);
  const counts = useMemo(
    () =>
      memoryCounts(
        records.data?.map((h) => h.record) ?? [],
        threads.data ?? [],
        facts.data ?? [],
        projectOrgs,
      ),
    [records.data, threads.data, facts.data, projectOrgs],
  );

  const known = (id: string | undefined): id is string =>
    id !== undefined && (id === GLOBAL || projectOrgs.has(id));
  const stored = readStored(PROJECT_KEY);
  const selected = known(search.project)
    ? search.project
    : known(stored)
      ? stored
      : (projectList[0]?.id ?? GLOBAL);
  const tab: MemoryTab =
    MEMORY_TABS.find((t) => t === search.tab) ?? (selected === GLOBAL ? "lessons" : "brief");

  useEffect(() => {
    if (projects.data !== undefined) writeStored(PROJECT_KEY, selected);
  }, [projects.data, selected]);

  // Picking another project keeps the tab when it has one; the Global row starts on Lessons.
  const go = (next: { project?: string; tab?: MemoryTab }) => {
    const project = next.project ?? selected;
    const nextTab = next.tab ?? (project === GLOBAL ? "lessons" : selected === GLOBAL ? "brief" : tab);
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => ({ ...prev, project, tab: nextTab }),
      replace: true,
    });
  };

  const failed = projects.error ?? orgs.error;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Memory"
        wrapSubtitle
        subtitle="What majhi keeps per project: a short brief, a record of each finished task, what those tasks left open, and lessons."
      >
        <MemoryReviewActions
          facts={facts.data ?? []}
          projectOrgs={projectOrgs}
          orgs={orgs.data ?? []}
          selected={selected}
        />
      </PageHeader>
      {failed ? (
        <p role="alert" className="p-8 text-base text-red">
          Could not load memory: {describeError(failed)}
        </p>
      ) : (
        <ListDetail>
          <ListPane label="Projects">
            <MemoryList
              projects={projects.data}
              orgs={orgs.data ?? []}
              counts={counts}
              selected={selected}
              onSelect={(project) => go({ project })}
            />
          </ListPane>
          <MemoryDetail
            key={selected}
            target={selected}
            tab={tab}
            onTab={(t) => go({ tab: t })}
            project={projectList.find((p) => p.id === selected)}
            orgs={orgs.data ?? []}
            counts={counts}
            facts={facts}
            threads={threads}
            projectOrgs={projectOrgs}
          />
        </ListDetail>
      )}
    </div>
  );
}
