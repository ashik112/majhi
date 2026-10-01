import type { AutomationRun } from "@majhi/shared";
import { History, Pause, Pencil, Play, PlayCircle, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { SectionLabel } from "@/components/ui/section-label";
import { cn } from "@/lib/cn";
import { formatAgo } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { RUN_STATUS } from "./model";

/** The glass panel the rows sit in: column heads on top, rows scrolling under them, never the page. */
export function RowsPanel({
  label,
  columns,
  heads,
  children,
}: {
  label: string;
  /** The grid template of the heads and of every row. */
  columns: string;
  heads: readonly string[];
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={cn("flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl", GLASS)}>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain scroll-fade-end">
        <div className="min-w-[960px]">
          <div
            className="sticky top-0 z-10 grid items-center gap-4 border-b border-line bg-glass-strong px-4 py-2.5"
            style={{ gridTemplateColumns: columns }}
          >
            {heads.map((head, i) => (
              <SectionLabel key={head || `blank-${i}`}>{head}</SectionLabel>
            ))}
          </div>
          <ul className="flex flex-col">{children}</ul>
        </div>
      </div>
    </section>
  );
}

/** One row of the grid. */
export function GridRow({ columns, children }: { columns: string; children: ReactNode }) {
  return (
    <li
      className="grid items-start gap-4 border-b border-line px-4 py-3 last:border-b-0"
      style={{ gridTemplateColumns: columns }}
    >
      {children}
    </li>
  );
}

/** The last run as its lamp and word, its detail and how long ago. Nothing before the first run. */
export function LastRun({ run, now }: { run: AutomationRun | null; now: number }) {
  if (run === null) return <span className="text-sm text-fg-faint">Never ran</span>;
  const status = RUN_STATUS[run.status];
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className={cn("flex items-center gap-1.5 text-sm font-medium", LAMP_TEXT[status.lamp])}>
        <Lamp state={status.lamp} size={7} />
        {status.label}
        <span className="font-normal text-fg-faint">{formatAgo(run.startedAt, now)}</span>
      </span>
      <span className="line-clamp-2 text-sm text-fg-muted text-pretty" title={run.detail}>
        {run.detail}
      </span>
    </div>
  );
}

/** A schedule's or trigger's state as a badge, when it is not simply active. */
export function StateBadge({ paused, done }: { paused: boolean; done?: boolean }) {
  if (done) return <Badge>Done</Badge>;
  if (paused) return <Badge tone="amber">Paused</Badge>;
  return null;
}

/** Run now, Pause or Resume, History, Edit and Delete. */
export function RowActions({
  name,
  paused,
  done,
  busy,
  onRun,
  onToggle,
  onHistory,
  onEdit,
  onDelete,
}: {
  name: string;
  paused: boolean;
  done?: boolean;
  busy: boolean;
  onRun: () => void;
  onToggle: () => void;
  onHistory: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button size="sm" onClick={onRun} disabled={busy}>
        <PlayCircle aria-hidden="true" />
        Run now
      </Button>
      {!done && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggle}
          disabled={busy}
          aria-label={`${paused ? "Resume" : "Pause"} ${name}`}
          title={paused ? "Resume" : "Pause"}
        >
          {paused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={onHistory}
        aria-label={`History of ${name}`}
        title="History"
      >
        <History aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${name}`} title="Edit">
        <Pencil aria-hidden="true" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${name}`} title="Delete">
        <Trash2 aria-hidden="true" />
      </Button>
    </div>
  );
}
