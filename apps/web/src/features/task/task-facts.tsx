import type { IncidentView, Task } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { useIncident } from "@/lib/incident-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useTasks } from "@/lib/task-queries";

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The goal in one line: the first paragraph of the brief, else the title. */
function goalOf(task: Pick<Task, "brief" | "title">, brief: string): string {
  const first = brief.split("\n\n")[0]?.trim() ?? "";
  const line = (first === "" ? task.title : first)
    .split("\n")
    .map((s) => s.trim())
    .join(" ");
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

function Field({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-4 py-0.5">
      <dt className="w-20 shrink-0 text-base text-fg-faint">{label}</dt>
      <dd className={cn("m-0 min-w-0 text-base text-fg-soft", mono && "font-mono")}>{children}</dd>
    </div>
  );
}

/** What the owner told the client, newest first: "19:15 Investigating". */
function toldLine(view: IncidentView | null | undefined): string {
  const told = (view?.rooms ?? [])
    .flatMap((r) => (r.toldAt === undefined || r.sees === undefined ? [] : [{ at: r.toldAt, sees: r.sees }]))
    .toSorted((a, b) => (a.at < b.at ? 1 : -1))[0];
  return told === undefined ? "Not yet" : `${formatClock(told.at)} ${told.sees}`;
}

/**
 * The task's fields at the top of its room, by kind: the goal for every task, a code task's branch, an incident's cause
 * and what the client was told, and the follow-ups as links. Each is read from where it lives; nothing is stored here.
 */
export function TaskFacts({ task, brief }: { task: Task; brief: string }) {
  const list = useTasks().data ?? [];
  const { org } = useOrgFilter();
  const incident = task.typing?.type === "incident";
  const view = useIncident(task.id, incident).data;
  const followUps = list
    .filter((t) => t.links.some((l) => l.type === "follow-up" && l.task === task.id))
    .toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const branches = task.repos.map((r) => r.branch).filter((b) => b !== "");
  return (
    <dl className={cn("m-0 flex shrink-0 flex-col rounded-2xl px-5 py-2.5", GLASS)} aria-label="Task facts">
      <Field label="Goal">{goalOf(task, brief)}</Field>
      {incident && (
        <>
          <Field label="Cause">{view?.report?.internal.cause || "Not found yet"}</Field>
          <Field label="Client told">{toldLine(view)}</Field>
        </>
      )}
      {branches.length > 0 && (
        <Field label="Branch" mono>
          {branches.join(", ")}
        </Field>
      )}
      {followUps.length > 0 && (
        <Field label="Follow-ups">
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {followUps.map((f) => (
              <li key={f.id} className="flex min-w-0 gap-2">
                <Link
                  to="/t/$taskId"
                  params={{ taskId: f.id }}
                  search={orgSearch(org)}
                  className="shrink-0 font-mono text-fg underline decoration-line-control underline-offset-2 hover:decoration-current"
                >
                  {f.id}
                </Link>
                <span className="min-w-0 truncate">{f.title}</span>
              </li>
            ))}
          </ul>
        </Field>
      )}
    </dl>
  );
}
