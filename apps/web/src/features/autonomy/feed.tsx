import type { AutonomyEvent } from "@majhi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useAutonomyEvents } from "@/lib/autonomy-queries";
import { describeError } from "@/lib/errors";
import { clockTime, EVENT_WORD, eventTone, outcomeWord } from "./model";
import { CardHead } from "./sections";
import { TaskRef } from "./task-ref";

type Show = "all" | "decisions";

/**
 * The live feed, newest first, and the Decisions list as its second view: decisions, approvals and
 * refusals only. The `autonomy` topic refetches it; Load more reads the older events.
 */
export function FeedCard({ now }: { now: number }) {
  const [show, setShow] = useState<Show>("all");
  const feed = useAutonomyEvents(show === "decisions");
  const events = feed.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <Card aria-label={show === "all" ? "Live feed" : "Decisions"}>
      <CardHead title={show === "all" ? "Live feed" : "Decisions"}>
        <Segmented
          label="Show"
          value={show}
          segments={[
            { value: "all", label: "Everything" },
            { value: "decisions", label: "Decisions" },
          ]}
          onChange={setShow}
        />
      </CardHead>
      {feed.isError ? (
        <p role="alert" className="text-sm text-red">
          Could not load the feed: {describeError(feed.error)}
        </p>
      ) : feed.isPending ? (
        <RowsSkeleton rows={3} height={36} />
      ) : events.length === 0 ? (
        <p className="text-sm text-fg-faint">
          {show === "all" ? "Nothing happened yet." : "No decisions yet."} Every action lands here with one
          line why.
        </p>
      ) : (
        <ul className="flex flex-col">
          {events.map((event) => (
            <EventRow key={event.seq} event={event} now={now} />
          ))}
        </ul>
      )}
      {feed.hasNextPage && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}
        >
          {feed.isFetchingNextPage ? "Loading" : "Load more"}
        </Button>
      )}
    </Card>
  );
}

/** A reason that only repeats the event's own line ("Stopped after the current turns") adds nothing. */
function sameLine(a: string, b: string): boolean {
  const plain = (t: string) => t.trim().replace(/\.$/, "").toLowerCase();
  return plain(a) === plain(b);
}

function EventRow({ event, now }: { event: AutonomyEvent; now: number }) {
  return (
    <li className="flex min-w-0 gap-3 border-t border-line py-2 first:border-t-0">
      <time
        dateTime={event.at}
        title={new Date(event.at).toLocaleString()}
        className="tnum w-[68px] shrink-0 pt-0.5 font-mono text-xs text-fg-faint"
      >
        {clockTime(event.at, now)}
      </time>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Badge tone={eventTone(event)}>
            {EVENT_WORD[event.kind]}
            {event.outcome && `: ${outcomeWord(event.outcome)}`}
          </Badge>
          {event.task && <TaskRef task={event.task} item={event.item} />}
          {event.unsure && <Badge tone="amber">unsure</Badge>}
          <span className="min-w-0 text-base text-fg-soft text-pretty">{event.text}</span>
        </span>
        {event.reason && !sameLine(event.reason, event.text) && (
          <span className="text-sm text-fg-muted text-pretty">Why: {event.reason}</span>
        )}
      </span>
    </li>
  );
}
