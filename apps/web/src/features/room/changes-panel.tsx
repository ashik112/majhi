import type { RoomItem, Task } from "@majhi/shared";
import { ChevronRight, FileDiff, FileMinus, FileSymlink } from "lucide-react";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { plural } from "@/lib/format";
import { DiffView } from "./diff-view";
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
        Edits the agent made in this task. Full git diffs come with merge requests.
      </p>
    </Card>
  );
}

const CHANGE_ICON = { edit: FileDiff, delete: FileMinus, move: FileSymlink } as const;

function FileRow({ file }: { file: ReturnType<typeof filesByRepo>[number]["files"][number] }) {
  const [open, setOpen] = useState(false);
  const Icon = CHANGE_ICON[file.change];
  const diff = file.diffs.at(-1);
  const expandable = file.diffs.length > 0;
  const inner = (
    <>
      {expandable ? (
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0 text-fg-faint transition-transform", open && "rotate-90")}
        />
      ) : (
        <span aria-hidden="true" className="size-3 shrink-0" />
      )}
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
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-7 w-full items-center gap-1.5 rounded-sm px-1 text-left hover:bg-raised"
        >
          {inner}
        </button>
      ) : (
        <div className="flex h-7 items-center gap-1.5 px-1">{inner}</div>
      )}
      {open && diff && (
        <div className="mt-1 flex flex-col gap-2">
          {file.diffs.map((d, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: edits to one file keep their order
            <DiffView key={i} diff={d} compact />
          ))}
        </div>
      )}
    </li>
  );
}
