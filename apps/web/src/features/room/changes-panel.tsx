import type { RepoDiff, RepoDiffFile, RoomItem, Task, TaskRepo } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { FileDiff, FileMinus, FilePlus, FileSymlink } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { Card } from "@/components/ui/card";
import { repoTotals } from "@/features/changes/model";
import { viewablePath } from "@/features/viewer/model";
import { plural } from "@/lib/format";
import { useTaskDiff } from "@/lib/task-queries";
import { filesByRepo, shortPath, type TouchedFile, touchedFiles } from "./model";

/** Files listed per repo in the card; the Changes tab has the rest. */
const LIST_UP_TO = 8;

/**
 * The Changes card. Per repo, what git sees against the base (commits and uncommitted work, as in
 * the Changes tab), so edits made through a shell or by hand count too. Files an agent changed
 * outside the worktrees come from the room, because git does not see them.
 */
export function ChangesPanel({
  task,
  items,
  onShowChanges,
}: {
  task: Task;
  items: readonly RoomItem[];
  /** Opens the Changes tab. */
  onShowChanges?: (() => void) | undefined;
}) {
  const touched = useMemo(() => touchedFiles(items), [items]);
  const outside = useMemo(
    () => filesByRepo(touched, task.repos).find((group) => group.repo === undefined)?.files ?? [],
    [touched, task.repos],
  );
  const hasRepos = task.repos.length > 0;
  const diff = useTaskDiff(task.id, hasRepos);
  useRefetchOnTouch(diff.refetch, hasRepos ? touched.length : 0);
  const inRepos = (diff.data ?? []).reduce((sum, repo) => sum + repo.files.length + repo.omitted, 0);
  const total = inRepos + outside.length;

  return (
    <Card aria-labelledby="changes-heading" className="gap-2 px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <h2 id="changes-heading" className="text-sm font-semibold">
          Changes
        </h2>
        {(!hasRepos || diff.data) && (
          <span className="tnum text-xs text-fg-faint">
            {total === 0 ? "none yet" : plural(total, "file")}
          </span>
        )}
      </div>
      {task.repos.map((repo) => (
        <RepoChanges
          key={repo.project}
          repo={repo}
          diff={diff.data?.find((d) => d.project === repo.project)}
          loading={diff.isPending}
          failed={diff.error?.message}
          onShowChanges={onShowChanges}
        />
      ))}
      {outside.length > 0 && (
        <section
          aria-label="Changes outside the worktrees"
          className="flex flex-col gap-1.5 border-t border-line-strong pt-2.5"
        >
          <h3 className="font-mono text-xs text-fg-muted">Outside the worktrees</h3>
          <ul className="flex flex-col gap-0.5">
            {outside.map((file) => (
              <TouchedRow key={file.path} file={file} task={task} />
            ))}
          </ul>
        </section>
      )}
      {!hasRepos && outside.length === 0 && (
        <p className="text-sm text-fg-faint">Files the agent changes show up here.</p>
      )}
    </Card>
  );
}

/** Reads the diff again when an agent touches another file, so the card keeps up during a turn. */
function useRefetchOnTouch(refetch: () => unknown, count: number) {
  const seen = useRef(count);
  useEffect(() => {
    if (count === seen.current) return;
    seen.current = count;
    void refetch();
  }, [count, refetch]);
}

function RepoChanges({
  repo,
  diff,
  loading,
  failed,
  onShowChanges,
}: {
  repo: TaskRepo;
  diff: RepoDiff | undefined;
  loading: boolean;
  failed: string | undefined;
  onShowChanges: (() => void) | undefined;
}) {
  const totals = diff ? repoTotals(diff) : undefined;
  const more = diff ? Math.max(0, diff.files.length - LIST_UP_TO) + diff.omitted : 0;
  return (
    <section
      aria-label={`Changes in ${repo.project}`}
      className="flex flex-col gap-1.5 border-t border-line-strong pt-2.5"
    >
      <h3 className="flex items-baseline gap-2 font-mono text-xs text-fg-muted">
        {repo.project}
        {totals && totals.files > 0 && (
          <span className="tnum ml-auto">
            <span className="text-green">+{totals.additions}</span>{" "}
            <span className="text-red">-{totals.deletions}</span>
          </span>
        )}
      </h3>
      {loading && <p className="text-sm text-fg-faint">Reading the diff...</p>}
      {!loading && diff === undefined && failed !== undefined && (
        <p className="text-sm text-red text-pretty">{failed}</p>
      )}
      {diff?.error !== undefined && <p className="text-sm text-red text-pretty">{diff.error}</p>}
      {diff && diff.error === undefined && diff.files.length === 0 && (
        <p className="text-sm text-fg-faint">No changes against {diff.base} yet.</p>
      )}
      {diff && diff.files.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {diff.files.slice(0, LIST_UP_TO).map((file) => (
            <DiffRow key={file.path} file={file} onShowChanges={onShowChanges} />
          ))}
        </ul>
      )}
      {more > 0 && <p className="text-xs text-fg-faint">and {plural(more, "more file")}</p>}
      {diff?.uncommitted && <p className="text-xs text-amber">Some of this is not committed yet.</p>}
    </section>
  );
}

const STATUS_ICON = {
  added: FilePlus,
  modified: FileDiff,
  deleted: FileMinus,
  renamed: FileSymlink,
} as const;

function DiffRow({ file, onShowChanges }: { file: RepoDiffFile; onShowChanges: (() => void) | undefined }) {
  const Icon = STATUS_ICON[file.status];
  const inner = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate font-mono text-xs text-fg-soft" title={file.path}>
        {file.path}
      </span>
      <span className="ml-auto shrink-0 text-xs text-fg-faint">
        {file.status === "modified" ? "" : file.status}
      </span>
    </>
  );
  return (
    <li>
      {onShowChanges === undefined ? (
        <div className="flex h-7 min-w-0 items-center gap-1.5 px-1">{inner}</div>
      ) : (
        <button
          type="button"
          onClick={onShowChanges}
          aria-label={`Show the diff of ${file.path}`}
          className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-sm px-1 text-left hover:bg-raised"
        >
          {inner}
        </button>
      )}
    </li>
  );
}

const CHANGE_ICON = { edit: FileDiff, delete: FileMinus, move: FileSymlink } as const;

/** A file an agent changed outside the worktrees; it opens in the viewer with the agent's edits. */
function TouchedRow({ file, task }: { file: TouchedFile; task: Task }) {
  const Icon = CHANGE_ICON[file.change];
  const shown = shortPath(file.path, task.folder);
  const viewPath = viewablePath({ ...file, change: "edit" }, undefined, task.folder);
  const inner = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate font-mono text-xs text-fg-soft" title={file.path}>
        {shown}
      </span>
      <span className="ml-auto shrink-0 text-xs text-fg-faint">
        {file.change === "edit" ? "" : file.change === "delete" ? "deleted" : "moved"}
      </span>
    </>
  );
  return (
    <li>
      {viewPath === undefined ? (
        <div className="flex h-7 min-w-0 items-center gap-1.5 px-1">{inner}</div>
      ) : (
        <Link
          to="."
          search={(prev: object) => ({ ...prev, file: `changes:${viewPath}` })}
          aria-label={`Show changes in ${shown}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-1 hover:bg-raised"
        >
          {inner}
        </Link>
      )}
    </li>
  );
}
