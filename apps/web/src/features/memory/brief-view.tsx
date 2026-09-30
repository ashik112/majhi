import type { ProjectBrief, ProjectView } from "@majhi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Markdown } from "@/features/room/markdown";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useBuildBrief, useProjectBrief, useRestoreBrief } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";
import { ProjectPicker, useChosenProject } from "./project-picker";

/** Where a version came from: "After ACM-12", "Built from the repo docs", "Restored from version 3". */
function SourceText({ brief }: { brief: ProjectBrief }) {
  if (brief.source === "task" && brief.task !== undefined)
    return (
      <>
        After <TaskRef id={brief.task} />
      </>
    );
  if (brief.source === "restored" && brief.restored_from !== undefined)
    return <>Restored from version {brief.restored_from}</>;
  if (brief.source === "built") return <>Built from the repo docs and task records</>;
  return <>Updated</>;
}

/**
 * A project's living brief: what it is, how it is built, where it stands, what comes next and what
 * is known to be broken. The Housekeeper patches it after each task record; every version is kept
 * and any older one can be put back.
 */
export function BriefView({
  projects,
  orgNames,
}: {
  projects: readonly ProjectView[] | undefined;
  orgNames: ReadonlyMap<string, string>;
}) {
  const [project, setProject] = useChosenProject("majhi.memory.brief-project", projects, false);
  const brief = useProjectBrief(project);
  const build = useBuildBrief();
  const toast = useToast();
  const now = useNow(60_000);

  if (projects !== undefined && projects.length === 0) {
    return (
      <p className="m-0 text-base text-fg-muted text-pretty">
        No projects yet. Each registered project gets a brief after its first finished task.
      </p>
    );
  }
  const current = brief.data?.current;
  const older = (brief.data?.versions ?? []).filter((v) => v.version !== current?.version);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {projects === undefined ? (
          <Skeleton className="h-[34px] w-48" />
        ) : (
          <ProjectPicker projects={projects} orgNames={orgNames} value={project} onChange={setProject} />
        )}
        {current !== undefined && (
          <p className="m-0 min-w-0 flex-1 text-sm text-fg-faint">
            Version {current.version} · {formatAgo(current.created_at, now)} · <SourceText brief={current} />
          </p>
        )}
      </div>

      {brief.isError && <p className="m-0 text-base text-red">{describeError(brief.error)}</p>}
      {brief.isPending && project !== undefined && <Skeleton className="h-64 w-full rounded-xl" />}
      {brief.data !== undefined && current === undefined && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-line-strong bg-card px-5 py-4">
          <p className="m-0 text-base text-fg-muted text-pretty">
            No brief yet. It is written after the first task in this project is done.
          </p>
          <Button
            size="sm"
            disabled={build.isPending || project === undefined}
            onClick={() =>
              project !== undefined &&
              build.mutate(
                { project },
                {
                  onSuccess: () => toast("Brief written"),
                  onError: (e) =>
                    toast("The brief was not written", { detail: describeError(e), tone: "error" }),
                },
              )
            }
          >
            {build.isPending ? "Writing the brief" : "Build it now"}
          </Button>
        </div>
      )}
      {current !== undefined && (
        <article
          aria-label={`Brief of ${current.project}`}
          className="min-w-0 rounded-xl border border-line-strong bg-card px-5 py-4"
        >
          <Markdown text={current.body} size="document" />
        </article>
      )}

      {older.length > 0 && project !== undefined && (
        <section aria-label="Earlier versions" className="flex flex-col gap-2">
          <SectionLabel>History</SectionLabel>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {older.map((v) => (
              <VersionRow key={v.version} brief={v} project={project} now={now} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function VersionRow({ brief, project, now }: { brief: ProjectBrief; project: string; now: number }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string>();
  const restore = useRestoreBrief();
  const toast = useToast();
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-line-strong bg-card px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge mono>v{brief.version}</Badge>
        <span className="min-w-0 flex-1 text-fg-muted">
          {formatAgo(brief.created_at, now)} · <SourceText brief={brief} />
        </span>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
        <Button size="sm" onClick={() => setConfirm(true)}>
          Restore this version
        </Button>
      </div>
      {open && (
        <div className="min-w-0 border-t border-line pt-2">
          <Markdown text={brief.body} size="document" />
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Restore version ${brief.version}?`}
          body="It becomes the newest version of the brief. The current one stays in the history, so you can go back."
          confirmLabel="Restore"
          busy={restore.isPending}
          error={problem}
          onCancel={() => {
            setConfirm(false);
            setProblem(undefined);
          }}
          onConfirm={() =>
            restore.mutate(
              { project, version: brief.version },
              {
                onSuccess: () => {
                  setConfirm(false);
                  toast(`Restored version ${brief.version}`);
                },
                onError: (e) => setProblem(describeError(e)),
              },
            )
          }
        />
      )}
    </li>
  );
}
