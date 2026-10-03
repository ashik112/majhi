import { type AutonomyEvent, type CaptainAction, type CaptainStatus, CHORE_LABEL } from "@majhi/shared";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { clockTime, EVENT_WORD, eventTone, outcomeWord } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { useAutonomyEvents } from "@/lib/autonomy-queries";
import { useCaptainLog, useCaptainUndo } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { inLogView, LOG_FILTERS, type LogFilter, type LogLine, mergeLog } from "./log-model";

const OUTCOME: Record<
  CaptainAction["outcome"],
  { word: string; tone: "neutral" | "green" | "amber" | "red" }
> = {
  done: { word: "Did", tone: "green" },
  asked: { word: "For you", tone: "amber" },
  skipped: { word: "Left", tone: "neutral" },
  failed: { word: "Failed", tone: "red" },
};

/** A reason that only repeats the line's own words adds nothing. */
function sameLine(a: string, b: string): boolean {
  const plain = (t: string) => t.trim().replace(/\.$/, "").toLowerCase();
  return plain(a) === plain(b);
}

/**
 * The Log tab: what the captain did and decided, from its own record (upkeep, ships, answers) and
 * from autonomous work (starts, holds, approvals), newest first. Each line has its workspace, time,
 * what and why, and Undo where Undo is possible (a merge as a revert commit, a config change
 * through its history); a push says it cannot be undone. Filters: workspace and kind.
 */
export function CaptainLog({ status, now }: { status: CaptainStatus; now: number }) {
  const [org, setOrg] = useState("");
  const [filter, setFilter] = useState<LogFilter>("all");
  const log = useCaptainLog(undefined);
  const feed = useAutonomyEvents(false);
  const [undoing, setUndoing] = useState<CaptainAction>();
  const undo = useCaptainUndo();
  const toast = useToast();
  const name = (id: string) => status.orgs.find((o) => o.org === id)?.name ?? id;
  const lines = useMemo(
    () =>
      mergeLog(log.data?.actions ?? [], feed.data?.pages.flatMap((p) => p.events) ?? []).filter((l) =>
        inLogView(l, org, filter),
      ),
    [log.data, feed.data, org, filter],
  );
  const loading = log.isPending || feed.isPending;
  const failed = log.error ?? feed.error;
  return (
    <section
      aria-label="Log"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <Segmented label="Show in the log" value={filter} segments={LOG_FILTERS} onChange={setFilter} />
        <Select
          aria-label="Workspace"
          value={org}
          onChange={(e) => setOrg(e.target.value)}
          className="ml-auto h-8 w-auto text-sm"
        >
          <option value="">All workspaces</option>
          {status.orgs.map((o) => (
            <option key={o.org} value={o.org}>
              {o.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 pt-1 pb-6 scroll-fade">
        {failed ? (
          <p role="alert" className="pt-2 text-sm text-red">
            Could not load the log: {describeError(failed)}
          </p>
        ) : loading ? (
          <RowsSkeleton rows={5} height={40} />
        ) : lines.length === 0 && !feed.hasNextPage ? (
          <p className="pt-2 text-sm text-fg-faint text-pretty">
            {filter === "all" && org === ""
              ? "Nothing yet. Each thing the captain does lands here with why, and Undo where it can."
              : "Nothing here under this filter."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {lines.map((line) => (
              <li key={line.key} className="flex min-w-0 gap-2.5 border-t border-line py-2 first:border-t-0">
                <time
                  dateTime={line.at}
                  title={new Date(line.at).toLocaleString()}
                  className="tnum w-11 shrink-0 pt-[3px] font-mono text-xs text-fg-faint"
                >
                  {clockTime(line.at, now)}
                </time>
                <LineBody line={line} workspace={org === "" ? lineOrg(line, name) : undefined} />
                {line.source === "captain" && line.action.undo === "yes" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 self-start"
                    onClick={() => setUndoing(line.action)}
                  >
                    Undo
                  </Button>
                )}
                {line.source === "captain" && line.action.undo === "done" && (
                  <Badge
                    className="shrink-0 self-start"
                    title={
                      line.action.undoneAt === undefined
                        ? undefined
                        : new Date(line.action.undoneAt).toLocaleString()
                    }
                  >
                    Undone
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        {feed.hasNextPage && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-2 self-start"
            disabled={feed.isFetchingNextPage}
            onClick={() => void feed.fetchNextPage()}
          >
            {feed.isFetchingNextPage ? "Loading" : "Load more"}
          </Button>
        )}
      </div>
      {undoing && (
        <ConfirmDialog
          title="Undo this?"
          body={
            <span className="text-pretty">
              {undoing.text}.{" "}
              {undoing.chore === "ship"
                ? "A new commit reverts the merge; later work on the branch stays."
                : "It goes back the way it was."}
            </span>
          }
          confirmLabel="Undo"
          busy={undo.isPending}
          error={undo.error ? describeError(undo.error) : undefined}
          onConfirm={() =>
            undo.mutate(
              { id: undoing.id },
              {
                onSuccess: (done) => {
                  setUndoing(undefined);
                  toast("Undone", { detail: done.detail });
                },
              },
            )
          }
          onCancel={() => {
            undo.reset();
            setUndoing(undefined);
          }}
        />
      )}
    </section>
  );
}

function lineOrg(line: LogLine, name: (id: string) => string): string | undefined {
  return line.org === undefined ? undefined : name(line.org);
}

function LineBody({ line, workspace }: { line: LogLine; workspace: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      {line.source === "captain" ? (
        <ActionBody action={line.action} workspace={workspace} />
      ) : (
        <EventBody event={line.event} workspace={workspace} />
      )}
    </span>
  );
}

function Chip({ children }: { children: string }) {
  return (
    <span className="mr-1.5 inline-block max-w-[40%] truncate rounded-full border border-line-control px-2 py-px align-[-2px] text-xs text-fg-soft">
      {children}
    </span>
  );
}

function ActionBody({ action: a, workspace }: { action: CaptainAction; workspace: string | undefined }) {
  return (
    <>
      <span className="min-w-0 text-sm text-fg-soft">
        {workspace && <Chip>{workspace}</Chip>}
        <Badge tone={OUTCOME[a.outcome].tone} className="mr-1.5 align-[1px]">
          {OUTCOME[a.outcome].word}
        </Badge>
        {a.task && <TaskRef task={a.task} className="mr-1.5" />}
        <span className="text-pretty">{a.text}</span>
      </span>
      <span className="text-xs text-fg-faint">{CHORE_LABEL[a.chore]}</span>
      <span className="text-sm text-fg-muted text-pretty">Why: {a.reason}</span>
      {a.evidence && <span className="text-sm text-fg-faint text-pretty">Checked: {a.evidence}</span>}
      {a.outcome === "done" && a.undo === "no" && a.undoNote && (
        <span className="text-xs text-fg-faint text-pretty">No Undo: {a.undoNote}</span>
      )}
    </>
  );
}

function EventBody({ event, workspace }: { event: AutonomyEvent; workspace: string | undefined }) {
  return (
    <>
      <span className="min-w-0 text-sm text-fg-soft">
        {workspace && <Chip>{workspace}</Chip>}
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
    </>
  );
}
