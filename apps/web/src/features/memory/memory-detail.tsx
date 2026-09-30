import type { Fact, OrgView, ProjectBrief, ProjectView, Thread } from "@majhi/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { Globe, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Lamp } from "@/components/ui/lamp";
import { DetailPane } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { useToast } from "@/components/ui/toast";
import { orgLabel } from "@/features/accounts/model";
import { TaskRef } from "@/features/task-drawer/task-ref";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatAgo } from "@/lib/format";
import { useBuildBrief, useProjectBrief } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";
import { BriefTab } from "./brief-tab";
import { LessonsTab } from "./lessons-tab";
import { countsOf, GLOBAL, type MemoryCounts, type MemoryTab, type ProjectOrgs, proseBrief } from "./model";
import { TasksTab } from "./tasks-tab";
import { ThreadsTab } from "./threads-tab";

const TAB_LABEL: Record<MemoryTab, string> = {
  brief: "Brief",
  tasks: "Tasks",
  threads: "Threads",
  lessons: "Lessons",
};

/** The picked project (or the Global row): who it is, when its brief last changed, and four tabs. */
export function MemoryDetail({
  target,
  tab,
  onTab,
  project,
  orgs,
  counts,
  facts,
  threads,
  projectOrgs,
}: {
  target: string;
  tab: MemoryTab;
  onTab: (tab: MemoryTab) => void;
  project: ProjectView | undefined;
  orgs: readonly OrgView[];
  counts: ReadonlyMap<string, MemoryCounts>;
  facts: UseQueryResult<Fact[], ApiRequestError>;
  threads: UseQueryResult<Thread[], ApiRequestError>;
  projectOrgs: ProjectOrgs;
}) {
  const global = target === GLOBAL;
  const brief = useProjectBrief(global ? undefined : target);
  const [rebuilding, setRebuilding] = useState(false);
  const c = countsOf(counts, target);
  const tabs: MemoryTab[] = global
    ? [
        "lessons",
        ...(c.open > 0 ? (["threads"] as const) : []),
        ...(c.records > 0 ? (["tasks"] as const) : []),
      ]
    : ["brief", "tasks", "threads", "lessons"];
  const shown = tabs.includes(tab) ? tab : (tabs[0] ?? "lessons");
  const current = brief.data?.current;

  return (
    <DetailPane
      label={global ? "Global lessons" : `Memory of ${target}`}
      head={
        <div className="flex flex-col gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Identity
              target={target}
              project={project}
              orgs={orgs}
              brief={current}
              briefPending={brief.isPending}
            />
            {!global && shown === "brief" && current !== undefined && !proseBrief(current.body) && (
              <Button size="sm" className="ml-auto shrink-0" onClick={() => setRebuilding(true)}>
                <RefreshCw aria-hidden="true" />
                Rebuild brief
              </Button>
            )}
          </div>
          <div
            role="tablist"
            aria-label="Memory"
            className="flex min-w-0 gap-1 self-start rounded-[9px] border border-line-strong bg-field p-[3px]"
          >
            {tabs.map((t) => {
              const on = t === shown;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => onTab(t)}
                  className={cn(
                    "flex h-8 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm transition-colors duration-150",
                    on
                      ? "bg-selected font-medium text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
                      : "text-fg-muted hover:bg-raised hover:text-fg",
                  )}
                >
                  {TAB_LABEL[t]}
                  <TabCount tab={t} counts={c} />
                </button>
              );
            })}
          </div>
        </div>
      }
    >
      <div role="tabpanel" aria-label={TAB_LABEL[shown]}>
        {shown === "brief" && project !== undefined && (
          <BriefTab project={project.id} brief={brief} onRebuild={() => setRebuilding(true)} />
        )}
        {shown === "tasks" && <TasksTab project={global ? undefined : target} />}
        {shown === "threads" && <ThreadsTab target={target} threads={threads} />}
        {shown === "lessons" && (
          <LessonsTab target={target} facts={facts} projectOrgs={projectOrgs} orgs={orgs} />
        )}
      </div>
      {rebuilding && <RebuildDialog project={target} onClose={() => setRebuilding(false)} />}
    </DetailPane>
  );
}

function TabCount({ tab, counts }: { tab: MemoryTab; counts: MemoryCounts }) {
  if (tab === "lessons" && counts.waiting > 0)
    return (
      <span className="flex items-center gap-1 text-lamp-needs">
        <Lamp state="needs" size={6} />
        <span className="tnum font-mono text-xs">{counts.waiting}</span>
        <span className="sr-only">to review</span>
      </span>
    );
  const n =
    tab === "tasks"
      ? counts.records
      : tab === "threads"
        ? counts.open
        : tab === "lessons"
          ? counts.lessons
          : undefined;
  if (n === undefined) return null;
  return <span className="tnum font-mono text-xs text-fg-faint">{n}</span>;
}

/** The project's org badge and id, then its org and when the brief last changed and why. */
function Identity({
  target,
  project,
  orgs,
  brief,
  briefPending,
}: {
  target: string;
  project: ProjectView | undefined;
  orgs: readonly OrgView[];
  brief: ProjectBrief | undefined;
  briefPending: boolean;
}) {
  const now = useNow(60_000);
  if (target === GLOBAL || project === undefined)
    return (
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line-control bg-raised text-fg-soft"
        >
          <Globe className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-md leading-6 font-semibold">Global lessons</h2>
          <p className="truncate text-sm text-fg-muted">Lessons that hold in every org and project.</p>
        </div>
      </div>
    );
  const org = orgLabel(project.org, orgs);
  const key = orgs.find((o) => o.id === project.org)?.key ?? project.org;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <OrgBadge label={badgeLetters(key)} color={org.color} className="size-8 rounded-lg text-xs" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="truncate font-mono text-md leading-6 font-semibold">{project.id}</h2>
        <p className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted">
          <span className="shrink-0">{org.name}</span>
          <span aria-hidden="true" className="text-fg-dim">
            ·
          </span>
          <span className="min-w-0 truncate">
            {briefPending ? (
              "Reading the brief"
            ) : brief === undefined ? (
              "No brief yet"
            ) : (
              <>
                Brief <span className="tnum font-mono">v{brief.version}</span>,{" "}
                {brief.source === "task" && brief.task !== undefined ? (
                  <>
                    updated by <TaskRef id={brief.task} />
                  </>
                ) : brief.source === "restored" ? (
                  <>restored from v{brief.restored_from}</>
                ) : (
                  "built from the docs"
                )}{" "}
                {formatAgo(brief.created_at, now)}
              </>
            )}
          </span>
        </p>
      </div>
    </div>
  );
}

/** Rebuilding spends tokens and replaces the brief, so it asks first. The old one stays in History. */
export function RebuildDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const build = useBuildBrief();
  const toast = useToast();
  const [problem, setProblem] = useState<string>();
  return (
    <ConfirmDialog
      title={`Rebuild the brief of ${project}?`}
      body="The Housekeeper writes it again from the repo docs and the task records, as short bullets. This spends tokens. The current version stays in History."
      confirmLabel="Rebuild"
      busy={build.isPending}
      error={problem}
      onCancel={onClose}
      onConfirm={() =>
        build.mutate(
          { project },
          {
            onSuccess: () => {
              onClose();
              toast("Brief rebuilt");
            },
            onError: (e) => setProblem(describeError(e)),
          },
        )
      }
    />
  );
}
