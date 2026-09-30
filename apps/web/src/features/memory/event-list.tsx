import type { Fact, MemoryEvent } from "@majhi/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useUndoStep } from "@/lib/memory-queries";
import { useNow } from "@/lib/use-now";
import { actionLabel, actorLabel, canUndo, percent } from "./model";

const TONE = {
  Kept: "green",
  Approved: "green",
  Dropped: "red",
  Rejected: "red",
  Retired: "amber",
  Forgotten: "amber",
  Merged: "blue",
  "Already known": "blue",
} as const;

/**
 * Logged steps, newest first: what was done, who did it, the reason and how sure the decision was,
 * with Undo where the step can be reversed. `facts` gives each step the words of its fact.
 */
export function EventList({
  events,
  facts,
  label,
  empty,
  showText = true,
  flat = false,
}: {
  events: readonly MemoryEvent[];
  facts: ReadonlyMap<number, Fact>;
  label: string;
  empty: string;
  /** Leave out the fact's words when the list sits under the fact itself. */
  showText?: boolean;
  /** Rows divided by hairlines instead of boxed, inside a detail pane. */
  flat?: boolean;
}) {
  const now = useNow(30_000);
  const undo = useUndoStep();
  const toast = useToast();
  const [busy, setBusy] = useState<number>();
  if (events.length === 0) return <p className="m-0 text-sm text-fg-faint">{empty}</p>;
  return (
    <ul aria-label={label} className={cn("m-0 flex list-none flex-col p-0", !flat && "gap-1.5")}>
      {events.map((event) => {
        const word = actionLabel(event);
        const fact = facts.get(event.fact);
        return (
          <li
            key={event.id}
            className={
              flat
                ? "flex flex-col gap-1 border-t border-line py-2.5 text-sm first:border-t-0"
                : "flex flex-col gap-1 rounded-lg border border-line-strong bg-card px-3 py-2 text-sm"
            }
          >
            <div className="flex items-center gap-2">
              <Badge tone={word in TONE ? TONE[word as keyof typeof TONE] : "neutral"}>{word}</Badge>
              {showText ? (
                <span className="min-w-0 flex-1 truncate text-fg" title={fact?.text}>
                  {fact?.text ?? `Fact ${event.fact}`}
                </span>
              ) : (
                <span className="min-w-0 flex-1 text-xs text-fg-faint">
                  {actorLabel(event)}
                  {event.confidence !== undefined && ` · ${percent(event.confidence)} sure`}
                  {" · "}
                  {formatAgo(event.at, now)}
                </span>
              )}
              {event.undone && <Badge tone="neutral">Undone</Badge>}
              {canUndo(event) && (
                <Button
                  size="sm"
                  disabled={busy === event.id}
                  aria-label={`Undo: ${word} ${fact?.text ?? `fact ${event.fact}`}`}
                  onClick={() => {
                    setBusy(event.id);
                    undo.mutate(
                      { event: event.id },
                      {
                        onSuccess: () => toast("Undone"),
                        onError: (e) => toast("Could not undo", { detail: describeError(e), tone: "error" }),
                        onSettled: () => setBusy(undefined),
                      },
                    );
                  }}
                >
                  Undo
                </Button>
              )}
            </div>
            {showText && (
              <p className="m-0 text-xs text-fg-faint">
                {actorLabel(event)}
                {event.confidence !== undefined && ` · ${percent(event.confidence)} sure`}
                {" · "}
                {formatAgo(event.at, now)}
              </p>
            )}
            {event.reason !== undefined && <p className="m-0 text-fg-muted text-pretty">{event.reason}</p>}
          </li>
        );
      })}
    </ul>
  );
}
