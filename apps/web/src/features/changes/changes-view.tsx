import type { RepoDiff, RepoDiffFile, RoomItem, Task } from "@majhi/shared";
import { ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { plural } from "@/lib/format";
import { useTaskDiff } from "@/lib/task-queries";
import { diffAnchors, fileNote, repoTotals } from "./model";
import { PatchView } from "./patch-view";
import { ReviewBar } from "./review-bar";

/** Files open by default in a repo up to this many; a bigger change starts folded. */
const OPEN_UP_TO = 8;

/** The Changes tab: per repo, what the branch changed against its base, as git's own diffs. */
export function ChangesView({ task, onSent }: { task: Task; onSent: (item: RoomItem) => void }) {
  const diff = useTaskDiff(task.id, true);
  // Until the diff is there, no comment counts as gone from it.
  const anchors = useMemo(() => (diff.data ? diffAnchors(diff.data) : undefined), [diff.data]);
  return (
    <section aria-label="Changes" className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex items-center gap-2">
        <p className="text-sm text-fg-muted">
          Each repo against its base branch: commits and uncommitted work together.
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={diff.isFetching}
          onClick={() => void diff.refetch()}
        >
          <RefreshCw aria-hidden="true" className={diff.isFetching ? "animate-spin" : undefined} />
          Refresh
        </Button>
      </div>
      {diff.isError && (
        <p role="alert" className="text-sm text-red text-pretty">
          {diff.error.message}
        </p>
      )}
      {diff.isPending && <Skeleton className="h-32 w-full rounded-xl" />}
      {diff.data?.length === 0 && (
        <p className="text-sm text-fg-faint">This task has no repo yet, so there is nothing to compare.</p>
      )}
      {diff.data?.map((repo) => (
        <RepoSection key={repo.project} repo={repo} task={task} />
      ))}
      <ReviewBar task={task} anchors={anchors} onSent={onSent} />
    </section>
  );
}

function RepoSection({ repo, task }: { repo: RepoDiff; task: Task }) {
  const totals = repoTotals(repo);
  const mr = task.repos.find((r) => r.project === repo.project)?.mr;
  return (
    <section
      aria-label={`Changes in ${repo.project}`}
      className="flex flex-col gap-2 rounded-xl border border-line-strong bg-card px-3 py-2.5"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h2 className="font-mono text-sm font-semibold">{repo.project}</h2>
        <span className="font-mono text-xs text-fg-faint">
          {repo.branch} against {repo.base}
        </span>
        <span className="tnum ml-auto flex gap-2 font-mono text-xs">
          <span className="text-fg-muted">{plural(totals.files, "file")}</span>
          <span className="text-green">+{totals.additions}</span>
          <span className="text-red">-{totals.deletions}</span>
        </span>
        {mr && (
          <a
            href={mr.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
          >
            MR #{mr.number}
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        )}
      </div>
      {repo.uncommitted && (
        <p className="text-xs text-amber">
          Some of this is not committed yet. A merge request carries only committed work.
        </p>
      )}
      {repo.error && <p className="text-sm text-red text-pretty">{repo.error}</p>}
      {!repo.error && repo.files.length === 0 && (
        <p className="text-sm text-fg-faint">No changes against {repo.base}.</p>
      )}
      {repo.files.map((file) => (
        <FileDiff
          key={file.path}
          file={file}
          open={repo.files.length <= OPEN_UP_TO}
          review={{ task: task.id, repo: repo.project, path: file.path }}
        />
      ))}
      {repo.omitted > 0 && (
        <p className="text-xs text-fg-faint">
          {plural(repo.omitted, "more file")} not listed. Read the rest on the host.
        </p>
      )}
    </section>
  );
}

function FileDiff({
  file,
  open,
  review,
}: {
  file: RepoDiffFile;
  open: boolean;
  review: { task: string; repo: string; path: string };
}) {
  const note = fileNote(file);
  return (
    <details open={open} className="group overflow-hidden rounded-md border border-line-strong bg-sunken">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 font-mono text-xs marker:hidden hover:bg-raised">
        <ChevronRight
          aria-hidden="true"
          className="size-3.5 shrink-0 text-fg-faint transition-transform group-open:rotate-90"
        />
        <span className="min-w-0 truncate text-fg-soft" title={file.path}>
          {file.path}
        </span>
        {note && <span className="shrink-0 text-fg-faint">{note}</span>}
        <span className="tnum ml-auto shrink-0 text-green">+{file.additions}</span>
        <span className="tnum shrink-0 text-red">-{file.deletions}</span>
      </summary>
      {file.patch !== "" && (
        <div className="max-h-[520px] overflow-auto border-t border-line">
          <PatchView patch={file.patch} review={review} />
        </div>
      )}
    </details>
  );
}
