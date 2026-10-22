import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Lamp } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import { useNow } from "@/lib/use-now";
import { valueParts } from "./system-lines";
import { clockSince } from "./tool-row";

/** How many of the newest rows a running turn keeps open. */
export const RUNNING_ROWS = 4;

/** A line with its backticked values in mono, so a command in the summary reads as one. */
function Summary({ text }: { text: string }) {
  return valueParts(text).map((part, i) =>
    part.value ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line keep their order
      <code key={i} className="font-mono text-xs text-fg-muted">
        {part.text}
      </code>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line keep their order
      <span key={i}>{part.text}</span>
    ),
  );
}

/**
 * What an agent did between two messages, folded into one line under the message: "3 steps · ran `date` +1 ·
 * majhi-tasks: get, status · 1 allowed by rule". A click opens the compact rows.
 */
export function StepsRow({
  summary,
  className,
  children,
}: {
  summary: string;
  className?: string | undefined;
  /** One node per row of the run, drawn once the line is opened. */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={cn("list-none", className)}>
      <div className="pl-[34px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="-ml-1.5 flex max-w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-sm text-fg-faint hover:bg-raised hover:text-fg-soft"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
          />
          <span className="min-w-0 truncate">
            <Summary text={summary} />
          </span>
        </button>
      </div>
      {open && <ol className="m-0 mt-1 flex list-none flex-col p-0">{children}</ol>}
    </li>
  );
}

/** m:ss since the turn began, ticking each second. */
function Elapsed({ since }: { since: string }) {
  const now = useNow(1000);
  return <span className="tnum font-mono text-xs text-fg-faint">{clockSince(since, now)}</span>;
}

/**
 * A turn that is running: its steps stay open under the message. The head says who works and for how long
 * ("@agent is working 2:14, 9 steps, 5 earlier"), then the newest rows follow; the earlier ones open on a click.
 */
export function RunningSteps({
  agent,
  since,
  rows,
  className,
}: {
  agent: string;
  /** When the turn began. */
  since: string;
  /** One node per row of the run, oldest first. */
  rows: readonly ReactNode[];
  className?: string | undefined;
}) {
  const [all, setAll] = useState(false);
  const hidden = all ? 0 : Math.max(0, rows.length - RUNNING_ROWS);
  const shown = hidden === 0 ? rows : rows.slice(-RUNNING_ROWS);
  return (
    <li className={cn("list-none", className)} aria-label={`@${agent} is working`}>
      <div className="flex min-h-6 items-center gap-2 pl-[34px] text-sm">
        <Lamp state="working" size={8} />
        <span className="font-medium text-lamp-working">
          <span className="font-mono">@{agent}</span> is working
        </span>
        <Elapsed since={since} />
        <span className="text-fg-faint">
          {rows.length} {rows.length === 1 ? "step" : "steps"}
        </span>
        {rows.length > RUNNING_ROWS && (
          <button
            type="button"
            aria-expanded={all}
            onClick={() => setAll((v) => !v)}
            className="-ml-1 cursor-pointer rounded-sm px-1 text-fg-faint hover:text-fg-soft"
          >
            {all ? "fewer" : `${rows.length - RUNNING_ROWS} earlier`}
            <ChevronRight
              aria-hidden="true"
              className={cn("ml-0.5 inline size-3 transition-transform", all && "rotate-90")}
            />
          </button>
        )}
      </div>
      <ol className="m-0 mt-1 flex list-none flex-col p-0">{shown}</ol>
    </li>
  );
}
