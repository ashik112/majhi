import type { RoomItem, Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { FileDiff, FileMinus, FileSymlink } from "lucide-react";
import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { viewablePath } from "@/features/viewer/model";
import { plural } from "@/lib/format";
import { filesByRepo, shortPath, touchedFiles } from "./model";

/** The Changes card: per repo the files the agent touched in this task, each with its diff. */
export function ChangesPanel({ task, items }: { task: Task; items: readonly RoomItem[] }) {
  const groups = useMemo(() => filesByRepo(touchedFiles(items), task.repos), [items, task.repos]);
  const total = groups.reduce((sum, group) => sum + group.files.length, 0);

  return (
    <Card aria-labelledby="changes-heading">
      <div className="flex items-baseline gap-2">
        <h2 id="changes-heading" className="text-body font-semibold">
          Changes
        </h2>
        <span className="tnum text-sm text-fg-faint">{total === 0 ? "none yet" : plural(total, "file")}</span>
      </div>
      {groups.map((group) => (
        <section
          key={group.repo?.project ?? "outside"}
          aria-label={group.repo ? `Changes in ${group.repo.project}` : "Changes outside the worktrees"}
          className="flex flex-col gap-1.5 border-t border-line-strong pt-2.5"
        >
          <h3 className="font-mono text-xs text-fg-muted">
            {group.repo ? group.repo.project : "Outside the worktrees"}
          </h3>
          {group.files.length === 0 ? (
            <p className="text-sm text-fg-faint">No files changed yet.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {group.files.map((file) => (
                <FileRow
                  key={file.path}
                  file={group.repo ? file : { ...file, shown: shortPath(file.path, task.folder) }}
                  viewPath={viewablePath({ ...file, change: "edit" }, group.repo?.worktree, task.folder)}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      {task.repos.length === 0 && groups.length === 0 && (
        <p className="text-sm text-fg-faint">Files the agent changes show up here.</p>
      )}
      <p className="text-xs text-fg-faint text-pretty">
        Click a file to see what changed. Full git diffs come with merge requests.
      </p>
    </Card>
  );
}

const CHANGE_ICON = { edit: FileDiff, delete: FileMinus, move: FileSymlink } as const;

function FileRow({
  file,
  viewPath,
}: {
  file: ReturnType<typeof filesByRepo>[number]["files"][number];
  viewPath: string | undefined;
}) {
  const Icon = CHANGE_ICON[file.change];
  const inner = (
    <>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate font-mono text-xs text-fg-soft" title={file.path}>
        {file.shown}
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
          aria-label={`Show changes in ${file.shown}`}
          className="flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-1 hover:bg-raised"
        >
          {inner}
        </Link>
      )}
    </li>
  );
}
