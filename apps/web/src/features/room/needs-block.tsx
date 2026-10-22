import { healsItself, type IncidentView, isCaptainThread, type RoomItem, type Task } from "@majhi/shared";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { useNow } from "@/lib/use-now";
import { IncidentLine, IncidentReport, incidentCardOpen } from "./incident-card";
import { type OwnerContext, usePauseView } from "./owner-cards";

type Paused = Extract<RoomItem, { type: "paused" }>;

/** An incident's line that takes the task's pause in: the pause's why and its buttons are the line's own. */
function IncidentWithPause({
  view,
  task,
  item,
  turning,
  working,
}: {
  view: IncidentView;
  task: Task;
  item: Paused;
  turning: NonNullable<OwnerContext["turning"]>;
  working: boolean;
}) {
  const pause = usePauseView(item, task, turning);
  return <IncidentLine view={view} task={task} pause={pause} working={working} />;
}

/**
 * What waits for the owner in this task, above the message box: one card, never a stack. The first thing that
 * waits (a question, an approval, the review, a pause) is the card; an open incident is one line over it, and when
 * the task is paused that line takes the pause in. What else waits comes after this one is answered, and a line
 * says how many.
 */
export function NeedsBlock({
  waiting,
  owner,
  incident,
  working,
  plan,
  render,
}: {
  /** The items that wait for the owner, the first one that matters first. */
  waiting: readonly RoomItem[];
  owner: OwnerContext | undefined;
  incident: IncidentView | null | undefined;
  /** An agent of the task is in its turn. */
  working: boolean;
  /** A deploy plan that waits for the owner's word, as its own row. */
  plan: ReactNode;
  render: (item: RoomItem) => ReactNode;
}) {
  const now = useNow(60_000);
  const task = owner?.task;
  const view = incidentCardOpen(incident) ? incident : undefined;
  const line = view !== undefined && view.status !== "resolved" ? view : undefined;
  const report = view?.status === "resolved" && view.report !== undefined ? view : undefined;
  // A pause of a captain lane that majhi is bringing back is no card until that has failed for ten minutes.
  const own = waiting.filter(
    (i) =>
      !(
        i.type === "paused" &&
        task !== undefined &&
        isCaptainThread(task) &&
        healsItself(i.reason, i.at, now)
      ),
  );
  const taken = line === undefined ? undefined : own.find((i): i is Paused => i.type === "paused");
  const rest = taken === undefined ? own : own.filter((i) => i !== taken);
  const primary = rest[0];
  const more = rest.length - (primary === undefined ? 0 : 1);
  if (line === undefined && report === undefined && primary === undefined && plan === undefined) return null;
  return (
    <section
      aria-label="Needs you"
      className={cn(
        "mt-2 flex max-h-[60%] shrink-0 flex-col rounded-xl px-3 py-0.5",
        GLASS,
        "border-lamp-needs/30",
      )}
    >
      <ol className="m-0 flex min-h-0 flex-col divide-y divide-line overflow-y-auto p-0">
        {line !== undefined &&
          task !== undefined &&
          (taken === undefined ? (
            <IncidentLine view={line} task={task} working={working} />
          ) : (
            <IncidentWithPause
              view={line}
              task={task}
              item={taken}
              turning={owner?.turning ?? []}
              working={working}
            />
          ))}
        {line !== undefined && task === undefined && (
          <IncidentLine view={line} task={undefined} working={working} />
        )}
        {primary !== undefined ? render(primary) : plan}
        {report !== undefined && <IncidentReport view={report} />}
      </ol>
      {more > 0 && (
        <p className="m-0 shrink-0 pb-1.5 pl-4 pt-1.5 text-sm text-fg-muted">
          {more === 1 ? "1 more waits" : `${more} more wait`} after this one.
        </p>
      )}
    </section>
  );
}
