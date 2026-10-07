import type { ProjectView } from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/list-detail";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Dot } from "@/components/ui/status-dot";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useDeployView } from "@/lib/deploy-queries";
import { useWiki, useWikiUpdate } from "@/lib/wiki-queries";
import { DEPLOY_PAGE_ID, lastReached, reachedLook, runHost, runsLine } from "./deploy-model";
import { TaskLink } from "./task-link";
import { TierChip } from "./tier-chip";

/** Earlier deploys of an environment shown under its row. */
const HISTORY_SHOWN = 8;

/** Opens the project's deploy page in the wiki, or writes it first when the wiki has none. */
function DeployPageButton({ project }: { project: ProjectView }) {
  const wiki = useWiki(project.org, project.id);
  const build = useWikiUpdate();
  const navigate = useNavigate();
  const toast = useToast();
  const has = wiki.data?.pages.some((p) => p.id === DEPLOY_PAGE_ID) ?? true;
  if (has || wiki.data?.enabled === false) {
    return (
      <Button asChild size="sm">
        <Link to="/wiki" search={{ org: project.org, project: project.id, id: DEPLOY_PAGE_ID }}>
          Deploy page
        </Link>
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      disabled={build.isPending}
      onClick={() =>
        build.mutate(
          { org: project.org, project: project.id, page: DEPLOY_PAGE_ID },
          {
            onSuccess: () =>
              void navigate({
                to: "/wiki",
                search: { org: project.org, project: project.id, id: DEPLOY_PAGE_ID },
              }),
            onError: (error) =>
              toast("Could not write the deploy page", { detail: error.message, tone: "error" }),
          },
        )
      }
    >
      {build.isPending ? "Writing..." : "Write deploy page"}
    </Button>
  );
}

/** Where the project is deployed, read only: one row per environment and what reached it last. */
export function DeploySection({ project }: { project: ProjectView }) {
  const view = useDeployView(project.id);
  const [open, setOpen] = useState<string>();

  if (view.isPending) {
    return (
      <DetailSection title="Deploys" className="pb-3">
        <RowsSkeleton rows={2} height={36} />
      </DetailSection>
    );
  }
  if (view.isError) {
    return (
      <DetailSection title="Deploys" className="pb-3">
        <p role="alert" className="text-sm text-red text-pretty">
          {view.error.message}
        </p>
      </DetailSection>
    );
  }
  const { environments, history } = view.data;
  if (environments.length === 0) {
    return (
      <DetailSection title="Deploys" className="pb-3">
        <p className="text-sm text-fg-faint">None found.</p>
      </DetailSection>
    );
  }
  const now = Date.now();
  return (
    <DetailSection title="Deploys" className="pb-3" actions={<DeployPageButton project={project} />}>
      <ul aria-label={`Environments of ${project.id}`} className="flex flex-col">
        {environments.map((environment) => {
          const reached = lastReached(history, environment.env);
          const first = reached?.runs[0];
          const look = reached === undefined ? undefined : reachedLook(reached, now);
          const earlier = history
            .filter((r) => r.env === environment.env && r.state !== "planned" && r.state !== "held")
            .slice(0, HISTORY_SHOWN);
          const expanded = open === environment.env;
          return (
            <li key={environment.env} className="border-t border-line first:border-t-0">
              <div className="grid min-h-9 grid-cols-[136px_92px_minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-sm">
                <span className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`History of ${environment.env}`}
                    title={earlier.length === 0 ? "Nothing deployed yet" : "Show the history"}
                    disabled={earlier.length === 0}
                    onClick={() => setOpen(expanded ? undefined : environment.env)}
                    className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-xs text-fg-faint hover:bg-raised hover:text-fg disabled:cursor-default disabled:opacity-40"
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")}
                    />
                  </button>
                  <span className="truncate font-mono text-fg" title={environment.env}>
                    {environment.env}
                  </span>
                </span>
                <span>
                  <TierChip tier={environment.tier} />
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-fg-soft">
                  {first !== undefined && reached !== undefined && (
                    <>
                      <HostGlyph host={runHost(first)} className="size-3.5" />
                      <span className="min-w-0 truncate font-mono text-xs" title={runsLine(reached.runs)}>
                        {runsLine(reached.runs)}
                      </span>
                    </>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-fg-faint">
                  {look !== undefined && (
                    <>
                      <Dot tone={look.tone} size={6} />
                      {look.text}
                    </>
                  )}
                </span>
              </div>
              {expanded && (
                <ul aria-label={`Deploys to ${environment.env}`} className="mb-2 ml-6 flex flex-col gap-1">
                  {earlier.map((record) => {
                    const line = reachedLook(record, now);
                    return (
                      <li key={record.id} className="flex min-w-0 items-center gap-2 text-xs text-fg-soft">
                        <Dot tone={line.tone} size={6} />
                        <span className="font-mono">{line.text}</span>
                        {record.task !== undefined && <TaskLink id={record.task} />}
                        {record.reason !== undefined && (
                          <span className="min-w-0 truncate text-fg-faint" title={record.reason}>
                            {record.reason}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </DetailSection>
  );
}
