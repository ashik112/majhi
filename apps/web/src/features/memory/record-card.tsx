import { RECORD_SECTION_TITLES, RECORD_SECTIONS, type RecordRepo, type TaskRecord } from "@majhi/shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Markdown } from "@/features/room/markdown";
import { TaskRef } from "@/features/task-drawer/task-ref";

/** "Sep 30, 2026": the day a record was written. */
export function recordDate(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Where one repo landed: merged into its base at a commit, or left on its branch. */
export function Landed({ repo, multi }: { repo: RecordRepo; multi: boolean }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-fg-muted">
      {multi && <span className="font-mono text-fg-soft [overflow-wrap:anywhere]">{repo.project}:</span>}
      {repo.merged ? (
        <span className="text-green">Merged into {repo.base}</span>
      ) : (
        <span>
          Not merged, on <span className="font-mono [overflow-wrap:anywhere]">{repo.branch}</span>
        </span>
      )}
      {repo.head !== undefined && <span className="font-mono text-fg-faint">{repo.head}</span>}
      <span className="text-fg-faint">
        {repo.commits} commit{repo.commits === 1 ? "" : "s"}
      </span>
      {repo.mr !== undefined && (
        <a
          href={repo.mr}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-0.5 text-fg-muted hover:text-fg"
        >
          Merge request
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      )}
    </span>
  );
}

/**
 * One task record: what it was for, what it did, what was decided, where it landed and what is
 * left. `compact` shows Asked and Done, with the rest behind Show all, to keep a long list calm.
 */
export function RecordCard({
  record,
  compact = true,
  header = true,
}: {
  record: TaskRecord;
  compact?: boolean;
  /** The title line. Off where the task is already the page (the task's own Memory tab). */
  header?: boolean;
}) {
  const [open, setOpen] = useState(!compact);
  const filled = RECORD_SECTIONS.filter((s) => record[s].trim() !== "");
  const shown = open ? filled : filled.filter((s) => s === "asked" || s === "done");
  const hidden = filled.length - shown.length;
  return (
    <article
      aria-label={`Record of ${record.task}`}
      className="flex flex-col gap-3 rounded-xl border border-line-strong bg-card px-4 py-3"
    >
      {header && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <TaskRef id={record.task} />
            <h3 className="m-0 min-w-0 flex-1 text-body font-semibold text-fg text-pretty [overflow-wrap:anywhere]">
              {record.title}
            </h3>
            <span className="shrink-0 text-xs text-fg-faint">{recordDate(record.created_at)}</span>
          </div>
          {record.projects.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {record.projects.map((p) => (
                <Badge key={p} mono className="max-w-full truncate">
                  {p}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
      {record.repos.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {record.repos.map((r) => (
            <Landed key={r.project} repo={r} multi={record.repos.length > 1} />
          ))}
        </div>
      )}
      <dl className="m-0 flex flex-col gap-2.5">
        {shown.map((s) => (
          <div key={s} className="flex flex-col gap-0.5">
            <dt>
              <SectionLabel>{RECORD_SECTION_TITLES[s]}</SectionLabel>
            </dt>
            <dd className="m-0 min-w-0 text-base text-fg">
              <Markdown text={record[s]} />
            </dd>
          </div>
        ))}
      </dl>
      {compact && (hidden > 0 || open) && filled.length > 2 && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>
            {open ? "Show less" : `Show all (${hidden} more)`}
          </Button>
        </div>
      )}
    </article>
  );
}
