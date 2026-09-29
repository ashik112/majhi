import type { RoomItem, Task, TaskRepo } from "@majhi/shared";
import { ChevronRight, Copy, FileDiff, FileMinus, FileSymlink } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useCopy } from "@/lib/use-copy";
import { DiffView } from "./diff-view";
import { filesByRepo, shortPath, touchedFiles } from "./model";

/** The Changes tab: per repo its branch, worktree and the files the agent touched in this task. */
export function ChangesPanel({ task, items }: { task: Task; items: readonly RoomItem[] }) {
  const groups = useMemo(() => filesByRepo(touchedFiles(items), task.repos), [items, task.repos]);
  const copy = useCopy();

  return (
    <div className="flex flex-col gap-3">
      {task.repos.length === 0 && (
        <p className="text-sm text-amber">
          No repo yet. Say which repos in the room, like "use api and web".
        </p>
      )}
      {groups.map((group) => (
        <section
          key={group.repo?.project ?? "outside"}
          aria-label={group.repo ? `Changes in ${group.repo.project}` : "Changes outside the worktrees"}
          className="flex flex-col gap-2 rounded-lg border border-line-strong bg-card p-3"
        >
          {group.repo ? (
            <RepoHeader repo={group.repo} onCopy={(path) => void copy(path)} />
          ) : (
            <h3 className="text-base font-semibold">Outside the worktrees</h3>
          )}
          {group.files.length === 0 ? (
            <p className="text-sm text-fg-faint">No files changed yet.</p>
          ) : (
            <ul className="flex flex-col gap-1">
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
      <p className="text-sm text-fg-faint text-pretty">
        These are the changes the agent made in this task, from its edits. Full git diffs come with merge
        requests.
      </p>
    </div>
  );
}

function RepoHeader({ repo, onCopy }: { repo: TaskRepo; onCopy: (path: string) => void }) {
  return (
    <>
      <h3 className="font-mono text-base font-semibold">{repo.project}</h3>
      <p className="font-mono text-xs text-fg-muted">
        {repo.branch} from {repo.base}
      </p>
      {repo.worktree ? (
        <div className="flex items-center gap-1">
          <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={repo.worktree}>
            {repo.worktree}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-my-1 size-6"
            aria-label={`Copy worktree path of ${repo.project}`}
            title="Copy path"
            onClick={() => onCopy(repo.worktree ?? "")}
          >
            <Copy aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-fg-faint">Worktree not created yet. It is made when the task starts.</p>
      )}
    </>
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
