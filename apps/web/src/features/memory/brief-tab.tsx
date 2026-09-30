import type { CommandOutput, ProjectBrief } from "@majhi/shared";
import type { UseQueryResult } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DetailSection } from "@/components/ui/list-detail";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Markdown } from "@/features/room/markdown";
import { TaskRef } from "@/features/task-drawer/task-ref";
import type { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useBuildBrief, useRestoreBrief } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";
import { briefSections, emptySection, proseBrief } from "./model";

/** Where a version came from: "after ACM-12", "built from the repo docs", "restored from v3". */
function SourceText({ brief }: { brief: ProjectBrief }) {
  if (brief.source === "task" && brief.task !== undefined)
    return (
      <>
        After <TaskRef id={brief.task} />
      </>
    );
  if (brief.source === "restored" && brief.restored_from !== undefined)
    return <>Restored from v{brief.restored_from}</>;
  if (brief.source === "built") return <>Built from the repo docs and task records</>;
  return <>Updated</>;
}

/**
 * A project's living brief as its sections, each one folding away, then every earlier version with
 * Restore. The Housekeeper patches it after each task record.
 */
export function BriefTab({
  project,
  brief,
  onRebuild,
}: {
  project: string;
  brief: UseQueryResult<CommandOutput<"memory.brief">, ApiRequestError>;
  onRebuild: () => void;
}) {
  const current = brief.data?.current;
  const older = (brief.data?.versions ?? []).filter((v) => v.version !== current?.version);
  if (brief.isError) return <p className="pt-5 text-base text-red">{describeError(brief.error)}</p>;
  if (brief.isPending)
    return (
      <div className="flex flex-col gap-3 pt-5">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  if (current === undefined) return <NoBrief project={project} />;
  const sections = briefSections(current.body);
  // Briefs written before they were kept to short bullets read as prose.
  const prose = proseBrief(current.body);
  return (
    <>
      {prose && (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-strong bg-raised px-3 py-2">
          <p className="min-w-0 flex-1 text-sm text-fg-muted text-pretty">
            This brief is long prose from before briefs were kept short. Rebuild it to get short bullets that
            point to the docs.
          </p>
          <Button size="sm" onClick={onRebuild}>
            Rebuild brief
          </Button>
        </div>
      )}
      <div className={cn("flex flex-col", prose && "pt-2")}>
        {sections.map((s) => (
          <BriefSection key={s.title || "brief"} title={s.title || "Brief"} text={s.text} folded={prose} />
        ))}
      </div>
      {older.length > 0 && <History project={project} versions={older} />}
    </>
  );
}

function NoBrief({ project }: { project: string }) {
  const build = useBuildBrief();
  const toast = useToast();
  return (
    <div className="flex max-w-[560px] flex-col items-start gap-3 pt-5">
      <h3 className="text-base font-semibold">No brief yet</h3>
      <p className="text-base text-fg-muted text-pretty">
        It is written after the first task in this project is done. It can also be built now from the repo
        docs, which spends a few tokens.
      </p>
      <Button
        size="sm"
        variant="primary"
        disabled={build.isPending}
        onClick={() =>
          build.mutate(
            { project },
            {
              onSuccess: () => toast("Brief written"),
              onError: (e) => toast("The brief was not written", { detail: describeError(e), tone: "error" }),
            },
          )
        }
      >
        {build.isPending ? "Writing the brief" : "Build the brief"}
      </Button>
    </div>
  );
}

/** One section of the brief, open until folded; a long prose brief starts folded. The count is its bullets. */
function BriefSection({ title, text, folded }: { title: string; text: string; folded: boolean }) {
  const [open, setOpen] = useState(!folded);
  const empty = emptySection(text);
  const bullets = text.split("\n").filter((l) => /^\s*[-*]\s/.test(l)).length;
  return (
    <section aria-label={title} className="border-t border-line first:border-t-0">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group flex min-h-11 w-full cursor-pointer items-center gap-2 text-left"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-fg-faint transition-transform duration-150 group-hover:text-fg-muted",
              open && "rotate-90",
            )}
          />
          <span className="text-base font-semibold text-fg">{title}</span>
          {empty ? (
            <span className="text-sm text-fg-faint">Nothing yet</span>
          ) : (
            bullets > 0 && <span className="tnum font-mono text-xs text-fg-faint">{bullets}</span>
          )}
        </button>
      </h3>
      {open && !empty && (
        <div className="min-w-0 max-w-[76ch] pb-4 pl-[22px] text-base text-fg-soft">
          <Markdown text={text} />
        </div>
      )}
    </section>
  );
}

function History({ project, versions }: { project: string; versions: readonly ProjectBrief[] }) {
  const now = useNow(60_000);
  return (
    <DetailSection
      title="History"
      note={`${versions.length} earlier ${versions.length === 1 ? "version" : "versions"}`}
    >
      <ul className="m-0 flex list-none flex-col p-0">
        {versions.map((v) => (
          <VersionRow key={v.version} brief={v} project={project} now={now} />
        ))}
      </ul>
    </DetailSection>
  );
}

function VersionRow({ brief, project, now }: { brief: ProjectBrief; project: string; now: number }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [problem, setProblem] = useState<string>();
  const restore = useRestoreBrief();
  const toast = useToast();
  return (
    <li className="flex flex-col border-t border-line first:border-t-0">
      <div className="flex min-h-10 items-center gap-3 text-sm">
        <span className="tnum w-8 shrink-0 font-mono text-fg-muted">v{brief.version}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">
          <SourceText brief={brief} />
          <span className="text-fg-faint"> · {formatAgo(brief.created_at, now)}</span>
        </span>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </Button>
        <Button size="sm" onClick={() => setConfirm(true)}>
          Restore
        </Button>
      </div>
      {open && (
        <div className="min-w-0 max-w-[76ch] pb-3 pl-11 text-sm text-fg-soft">
          <Markdown text={brief.body} />
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Restore version ${brief.version}?`}
          body="It becomes the newest version of the brief. The current one stays in History, so you can go back."
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
