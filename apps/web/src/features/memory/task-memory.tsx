import type { Fact, FactStatus, MemoryExtractOutput, Task, TaskRecord } from "@majhi/shared";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import {
  useApproveFact,
  useExtractMemory,
  useFacts,
  useMemoryEvents,
  useRejectFact,
  useTaskRecord,
  useThreads,
} from "@/lib/memory-queries";
import { useOrgs } from "@/lib/studio-queries";
import { EventList } from "./event-list";
import { scopeText } from "./model";
import { RecordCard, recordDate } from "./record-card";
import { ThreadRow } from "./threads-view";

const STATUS: Record<FactStatus, { label: string; tone: "amber" | "green" | "red" | "neutral" }> = {
  pending: { label: "Needs review", tone: "amber" },
  active: { label: "Active", tone: "green" },
  rejected: { label: "Dropped", tone: "red" },
  retired: { label: "Retired", tone: "neutral" },
};

/** Whether the task shows a Memory tab: it is done, it has lessons, or it has a record. */
export function hasMemoryTab(
  task: Pick<Task, "status">,
  facts: readonly Fact[],
  record?: TaskRecord | null,
): boolean {
  return task.status === "done" || facts.length > 0 || (record !== undefined && record !== null);
}

/**
 * What memory kept from this task: its record (asked, done, decisions, outcome, left), the lessons
 * it produced with what was decided about each, and the threads it left open.
 */
export function TaskMemory({ task }: { task: Task }) {
  const all = useFacts();
  const record = useTaskRecord(task.id);
  const threads = useThreads({ task: task.id });
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
  const written = record.data !== undefined && record.data !== null;
  const canWrite = task.status === "done";
  const fail = (title: string) => (e: unknown) => toast(title, { detail: describeError(e), tone: "error" });
  const known = steps.filter((e) => e.action === "duplicate" && !mine.some((f) => f.id === e.fact));

  return (
    <section
      aria-label="Memory of this task"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto pr-1"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <SectionLabel className="min-w-0 flex-1">
            Record{written && record.data ? ` · ${recordDate(record.data.updated_at)}` : ""}
          </SectionLabel>
          {canWrite && (
            <Button
              size="sm"
              disabled={extract.isPending}
              onClick={() =>
                extract.mutate(
                  { task: task.id },
                  {
                    onSuccess: (out) => toast(extractText(out)),
                    onError: fail("The record was not written"),
                  },
                )
              }
            >
              {extract.isPending ? "Writing" : written ? "Write again" : "Write the record"}
            </Button>
          )}
        </div>
        {record.isError && <p className="m-0 text-sm text-red">{describeError(record.error)}</p>}
        {record.isPending && <Skeleton className="h-32 w-full rounded-xl" />}
        {record.data !== undefined && record.data !== null && (
          <RecordCard record={record.data} compact={false} header={false} />
        )}
        {record.data === null && (
          <p className="m-0 text-base text-fg-muted text-pretty">
            {task.status === "done"
              ? "No record yet. The Housekeeper writes one when a task is done; Write the record asks it now."
              : "The Housekeeper writes this task's record when it is done: what it was for, what changed, what was decided and what is left."}
          </p>
        )}
      </div>

      {(threads.data ?? []).length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionLabel>Left open</SectionLabel>
          <ul aria-label="Threads this task left open" className="m-0 flex list-none flex-col gap-2 p-0">
            {(threads.data ?? []).map((t) => (
              <ThreadRow key={t.id} thread={t} showProject />
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <SectionLabel>Lessons from this task</SectionLabel>
        {all.isError && <p className="m-0 text-sm text-red">{describeError(all.error)}</p>}
        {mine.length === 0 && !all.isPending && (
          <p className="m-0 text-base text-fg-muted text-pretty">
            None. Lessons are rare: only a gotcha that cost time and is not already in the repo docs.
          </p>
        )}
        <ul aria-label="Lessons of this task" className="m-0 flex list-none flex-col gap-2 p-0">
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
                        onClick={() =>
                          approve.mutate({ id: fact.id }, { onError: fail("Could not approve") })
                        }
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
      </div>

      {known.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>Already known</SectionLabel>
          <EventList events={known} facts={byId} label="Lessons that were already in memory" empty="" />
        </div>
      )}
    </section>
  );
}

function extractText(out: MemoryExtractOutput): string {
  const parts = [
    out.record ? "record written" : undefined,
    out.briefs.length > 0 ? `brief updated for ${out.briefs.join(", ")}` : undefined,
    out.threads_opened > 0 ? `${plural(out.threads_opened, "thread")} opened` : undefined,
    out.threads_closed > 0 ? `${plural(out.threads_closed, "thread")} closed` : undefined,
    out.kept > 0 ? `${plural(out.kept, "lesson")} kept` : undefined,
    out.pending > 0 ? `${plural(out.pending, "lesson")} for your review` : undefined,
  ].filter((p) => p !== undefined);
  if (parts.length === 0) return "Nothing new was written.";
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
