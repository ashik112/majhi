import type { AutonomyEvent } from "@majhi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useAutonomyEvents } from "@/lib/autonomy-queries";
import { describeError } from "@/lib/errors";
import { Pane, SectionHead } from "./desk";
import { clockTime, EVENT_WORD, eventTone, inLog, type LogFilter, outcomeWord } from "./model";
import { TaskRef } from "./task-ref";

const EMPTY: Record<LogFilter, string> = {
  all: "Nothing happened yet.",
  decisions: "No decisions yet.",
  tasks: "No task changed yet.",
};

/**
 * The log: everything autonomous mode did, newest first, one compact row each with its one-line
 * why. The filter keeps decisions (with approvals and refusals) or task changes. The `autonomy`
 * topic refetches it; Load more reads older events.
 */
export function LogPane({ now, className }: { now: number; className?: string }) {
  const [filter, setFilter] = useState<LogFilter>("all");
  const feed = useAutonomyEvents(filter === "decisions");
  const events = (feed.data?.pages.flatMap((p) => p.events) ?? []).filter((e) => inLog(e, filter));

  return (
    <Pane
      label="Log"
      className={className}
      head={
        <SectionHead title="Log">
          <Segmented
            label="Show in the log"
            value={filter}
            segments={[
              { value: "all", label: "All" },
              { value: "decisions", label: "Decisions" },
              { value: "tasks", label: "Tasks" },
            ]}
            onChange={setFilter}
          />
        </SectionHead>
      }
    >
      {feed.isError ? (
        <p role="alert" className="text-sm text-red">
          Could not load the log: {describeError(feed.error)}
        </p>
      ) : feed.isPending ? (
        <RowsSkeleton rows={4} height={32} />
      ) : events.length === 0 && !feed.hasNextPage ? (
        <p className="text-sm text-fg-faint">{EMPTY[filter]} Every action lands here with one line why.</p>
      ) : (
        <ul className="-mt-1 flex flex-col">
          {events.map((event) => (
            <EventRow key={event.seq} event={event} now={now} />
          ))}
        </ul>
      )}
      {feed.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className="-mt-3 self-start"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage ? "Loading" : "Load more"}
        </Button>
      )}
    </Pane>
  );
}

/** A reason that only repeats the event's own line ("Stopped after the current turns") adds nothing. */
function sameLine(a: string, b: string): boolean {
  const plain = (t: string) => t.trim().replace(/\.$/, "").toLowerCase();
  return plain(a) === plain(b);
}

function EventRow({ event, now }: { event: AutonomyEvent; now: number }) {
  return (
    <li className="flex min-w-0 gap-2.5 border-t border-line py-1.5 first:border-t-0">
      <time
        dateTime={event.at}
        title={new Date(event.at).toLocaleString()}
        className="tnum w-11 shrink-0 pt-[3px] font-mono text-xs text-fg-faint"
      >
        {clockTime(event.at, now)}
      </time>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="min-w-0 text-sm text-fg-soft">
          <Badge tone={eventTone(event)} className="mr-1.5 align-[1px]">
            {EVENT_WORD[event.kind]}
            {event.outcome && event.outcome !== event.kind && `: ${outcomeWord(event.outcome)}`}
          </Badge>
          {event.task && <TaskRef task={event.task} item={event.item} className="mr-1.5" />}
          {event.unsure && (
            <Badge tone="amber" className="mr-1.5 align-[1px]">
              unsure
            </Badge>
          )}
          <span className="text-pretty">{event.text}</span>
        </span>
        {event.reason && !sameLine(event.reason, event.text) && (
          <span className="text-sm text-fg-muted text-pretty">Why: {event.reason}</span>
        )}
      </span>
    </li>
  );
}
