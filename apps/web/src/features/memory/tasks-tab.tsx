import { RECORD_SECTION_TITLES, RECORD_SECTIONS, type TaskRecord } from "@majhi/shared";
import { ChevronRight, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/features/room/markdown";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useTaskRecords } from "@/lib/memory-queries";
import { Landed, recordDate } from "./record-card";

/** Where a task landed, in a few words: "main", "2 of 3 merged" or "Not merged". Empty without repos. */
function landedShort(record: TaskRecord): { text: string; merged: boolean } | undefined {
  const repos = record.repos;
  if (repos.length === 0) return undefined;
  const merged = repos.filter((r) => r.merged);
  if (merged.length === repos.length) {
    const bases = [...new Set(merged.map((r) => r.base))];
    return { text: bases.length === 1 ? `Merged into ${bases[0]}` : "Merged", merged: true };
  }
  if (merged.length === 0) return { text: "Not merged", merged: false };
  return { text: `${merged.length} of ${repos.length} merged`, merged: false };
}

/** A project's task records, newest first, or ranked by a search. Each row opens to the whole record. */
export function TasksTab({ project }: { project: string | undefined }) {
  const [text, setText] = useState("");
  const query = useDeferredValue(text);
  const records = useTaskRecords({ query, project });
  const searching = query.trim() !== "";
  const all = records.data ?? [];
  // The Global row holds the records that name no project.
  const list = project === undefined ? all.filter((h) => h.record.projects.length === 0) : all;

  return (
    <div className="flex flex-col gap-3 pt-4">
      <div className="relative max-w-[520px]">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
        />
        <Input
          type="search"
          aria-label="Search task records"
          placeholder="Search past tasks: an area, a file, a problem"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="pl-9"
        />
      </div>
      {records.isError && <p className="text-base text-red">{describeError(records.error)}</p>}
      {records.isPending && <Skeleton className="h-32 rounded-lg" />}
      {records.data !== undefined &&
        (list.length === 0 ? (
          <p className="text-base text-fg-muted text-pretty">
            {searching
              ? "No finished task matches."
              : "No task records yet. When a task is done, the Housekeeper writes what it was for, what it changed, what was decided and what is left."}
          </p>
        ) : (
          <>
            {searching && (
              <p className="text-sm text-fg-faint">
                {list.length} {list.length === 1 ? "match" : "matches"}
              </p>
            )}
            <ol aria-label="Task records" className="m-0 flex list-none flex-col p-0">
              {list.map((hit) => (
                <RecordRow key={hit.record.id} record={hit.record} />
              ))}
            </ol>
          </>
        ))}
    </div>
  );
}

/** Id, title, where it landed and the day; open, the record's sections under it. */
function RecordRow({ record }: { record: TaskRecord }) {
  const [open, setOpen] = useState(false);
  const landed = landedShort(record);
  const filled = RECORD_SECTIONS.filter((s) => record[s].trim() !== "");
  return (
    <li
      aria-label={`Record of ${record.task}`}
      className="flex flex-col border-t border-line first:border-t-0"
    >
      <div className="flex min-h-10 min-w-0 items-center gap-3">
        <span className="w-[76px] shrink-0 text-sm">
          <TaskRef id={record.task} />
        </span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2 text-left"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-fg-faint transition-transform duration-150 group-hover:text-fg-muted",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 flex-1 truncate text-base text-fg group-hover:text-fg">
            {record.title}
          </span>
        </button>
        {landed && (
          <span
            className={cn(
              "hidden shrink-0 text-xs @[520px]:inline",
              landed.merged ? "text-green" : "text-fg-muted",
            )}
          >
            {landed.text}
          </span>
        )}
        <span className="tnum w-[88px] shrink-0 text-right text-xs text-fg-faint">
          {recordDate(record.created_at)}
        </span>
      </div>
      {open && (
        <div className="flex min-w-0 max-w-[80ch] flex-col gap-3 pb-4 pl-[98px]">
          {record.repos.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {record.repos.map((r) => (
                <Landed key={r.project} repo={r} multi={record.repos.length > 1} />
              ))}
            </div>
          )}
          <dl className="m-0 flex flex-col gap-2.5">
            {filled.map((s) => (
              <div key={s} className="flex flex-col gap-0.5">
                <dt className="text-sm font-medium text-fg-muted">{RECORD_SECTION_TITLES[s]}</dt>
                <dd className="m-0 min-w-0 text-base text-fg-soft">
                  <Markdown text={record[s]} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </li>
  );
}
