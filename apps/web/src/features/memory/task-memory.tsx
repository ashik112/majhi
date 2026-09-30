import type { Fact, FactStatus, MemoryExtractOutput, Task } from "@majhi/shared";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import {
  useApproveFact,
  useExtractMemory,
  useFacts,
  useMemoryEvents,
  useRejectFact,
} from "@/lib/memory-queries";
import { useOrgs } from "@/lib/studio-queries";
import { EventList } from "./event-list";
import { scopeText } from "./model";

const STATUS: Record<FactStatus, { label: string; tone: "amber" | "green" | "red" | "neutral" }> = {
  pending: { label: "Needs review", tone: "amber" },
  active: { label: "Active", tone: "green" },
  rejected: { label: "Dropped", tone: "red" },
  retired: { label: "Retired", tone: "neutral" },
};

/** Whether the task shows a Memory tab: it is done, or it has facts. */
export function hasMemoryTab(task: Pick<Task, "status">, facts: readonly Fact[]): boolean {
  return task.status === "done" || facts.length > 0;
}

/** The facts learned in this task, from agents and from the Housekeeper, with what was decided and Undo. */
export function TaskMemory({ task }: { task: Task }) {
  const all = useFacts();
  const events = useMemoryEvents({ task: task.id, limit: 200 });
  const orgs = useOrgs();
  const extract = useExtractMemory();
  const approve = useApproveFact();
  const reject = useRejectFact();
  const toast = useToast();
  const orgNames = useMemo(() => new Map((orgs.data ?? []).map((o) => [o.id, o.name])), [orgs.data]);
  const byId = useMemo(() => new Map((all.data ?? []).map((f) => [f.id, f])), [all.data]);
  const mine = useMemo(() => (all.data ?? []).filter((f) => f.task === task.id), [all.data, task.id]);
  const steps = events.data ?? [];
  const canExtract = task.status === "done" || mine.length === 0;
  const fail = (title: string) => (e: unknown) => toast(title, { detail: describeError(e), tone: "error" });

  return (
    <section
      aria-label="Memory of this task"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pr-1 pb-6 scroll-fade"
    >
      <div className="flex items-center gap-3">
        <p className="m-0 min-w-0 flex-1 text-base text-fg-muted text-pretty">
          Facts this task proposed, and those the Housekeeper wrote from its room. Approved facts are in the
          brief of later tasks.
        </p>
        {canExtract && (
          <Button
            size="sm"
            disabled={extract.isPending}
            onClick={() =>
              extract.mutate(
                { task: task.id },
                {
                  onSuccess: (out) => toast(extractText(out)),
                  onError: fail("The room was not read"),
                },
              )
            }
          >
            {extract.isPending ? "Reading the room" : "Extract again"}
          </Button>
        )}
      </div>

      {all.isError && <p className="m-0 text-sm text-red">{describeError(all.error)}</p>}
      {mine.length === 0 && !all.isPending && (
        <p className="m-0 text-base text-fg-muted text-pretty">
          Nothing was proposed in this task yet. Extract again has the Housekeeper read the room.
        </p>
      )}
      <ul aria-label="Facts of this task" className="m-0 flex list-none flex-col gap-2 p-0">
        {mine.map((fact) => {
          const status = STATUS[fact.status];
          const own = steps.filter((e) => e.fact === fact.id);
          return (
            <li
              key={fact.id}
              className="flex flex-col gap-2 rounded-xl border border-line-strong bg-card px-4 py-3"
            >
              <div className="flex items-start gap-3">
                <p className="m-0 min-w-0 flex-1 text-body text-fg text-pretty [overflow-wrap:anywhere]">
                  {fact.text}
                </p>
                {fact.status === "pending" && (
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      aria-label={`Approve: ${fact.text}`}
                      disabled={approve.isPending}
                      onClick={() => approve.mutate({ id: fact.id }, { onError: fail("Could not approve") })}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      aria-label={`Reject: ${fact.text}`}
                      disabled={reject.isPending}
                      onClick={() => reject.mutate({ id: fact.id }, { onError: fail("Could not reject") })}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-fg-faint">
                <Badge tone={status.tone}>{status.label}</Badge>
                <Badge>{scopeText(fact.scope, orgNames)}</Badge>
                {fact.agent !== undefined && <span>by @{fact.agent}</span>}
              </div>
              {own.length > 0 && (
                <EventList
                  events={own}
                  facts={byId}
                  label={`Steps for: ${fact.text}`}
                  empty=""
                  showText={false}
                />
              )}
            </li>
          );
        })}
      </ul>

      {steps.some((e) => e.action === "duplicate" && !mine.some((f) => f.id === e.fact)) && (
        <div className="flex flex-col gap-1.5">
          <h3 className="text-base font-semibold">Already known</h3>
          <EventList
            events={steps.filter((e) => e.action === "duplicate" && !mine.some((f) => f.id === e.fact))}
            facts={byId}
            label="Candidates that were already in memory"
            empty=""
          />
        </div>
      )}
    </section>
  );
}

function extractText(out: MemoryExtractOutput): string {
  if (out.candidates === 0) return "The Housekeeper found nothing worth keeping.";
  const parts = [
    out.kept > 0 ? `${out.kept} kept` : undefined,
    out.dropped > 0 ? `${out.dropped} dropped` : undefined,
    out.duplicates > 0 ? `${out.duplicates} already known` : undefined,
    out.rejected > 0 ? `${out.rejected} rejected` : undefined,
    out.pending > 0 ? `${out.pending} need your review` : undefined,
  ].filter((p) => p !== undefined);
  return `${plural(out.candidates, "fact")} written: ${parts.join(", ")}.`;
}
