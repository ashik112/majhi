import {
  CLIENT_STATUS_LABEL,
  type ClientStatus,
  type IncidentView,
  type OriginView,
  type Task,
} from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { cn } from "@/lib/cn";
import { formatSpan, formatTokens } from "@/lib/format";
import { useIncident } from "@/lib/incident-queries";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useTaskDetail, useTaskRow, useTasks } from "@/lib/task-queries";
import { useUsageSummary } from "@/lib/usage-queries";
import { useNow } from "@/lib/use-now";
import { originName } from "../tasks-ui/origin-mark";
import { CostText } from "../usage/cost";

function Row({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex min-w-0 gap-3 py-0.5 text-sm">
      <dt className="w-[68px] shrink-0 text-fg-faint">{label}</dt>
      <dd className={cn("m-0 min-w-0 text-fg-soft [overflow-wrap:anywhere]", mono && "font-mono text-xs")}>
        {children}
      </dd>
    </div>
  );
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** Where the task came from, as the link that goes there when there is one. */
function From({ origin }: { origin: OriginView }) {
  const { org } = useOrgFilter();
  const name = originName(origin);
  if (origin.kind === "parent") {
    return (
      <Link
        to="/t/$taskId"
        params={{ taskId: origin.task }}
        search={orgSearch(org)}
        className="underline decoration-line-control underline-offset-2 hover:decoration-current"
      >
        <span className="font-mono text-xs">{origin.task}</span>
        {origin.name === undefined ? "" : `, ${origin.name}`}
      </Link>
    );
  }
  if (origin.kind === "chat") {
    return (
      <Link
        to="/chats/$taskId"
        params={{ taskId: origin.room }}
        className="underline decoration-line-control underline-offset-2 hover:decoration-current"
      >
        {name}
      </Link>
    );
  }
  if (origin.kind === "deploy") {
    return (
      <PageLink
        page="projects"
        search={{ project: origin.project, section: "deploys" }}
        className="underline decoration-line-control underline-offset-2 hover:decoration-current"
      >
        {name}
      </PageLink>
    );
  }
  return <>{name}</>;
}

/**
 * Where the task came from, the watch that fires for it and what it cost so far. A task with none of
 * these has no card.
 */
export function TaskCard({ task }: { task: Task }) {
  const row = useTaskRow(task.id);
  const detail = useTaskDetail(task.id).data;
  const origin: OriginView | undefined = detail?.origin ?? row?.origin;
  const incident = useIncident(task.id, task.typing?.type === "incident").data ?? undefined;
  const summary = useUsageSummary({ task: task.id });
  const all = summary.data?.all;
  const cost = all !== undefined && all.turns > 0 && !summary.isPlaceholderData ? all : undefined;
  const watch = incident?.watch;
  if (origin === undefined && watch === undefined && cost === undefined) return null;
  return (
    <Card aria-label="Task" className="gap-1 px-3 py-2.5">
      <h2 className="pb-1 text-sm font-semibold">Task</h2>
      <dl className="m-0 flex flex-col">
        {origin !== undefined && (
          <Row label="From">
            <From origin={origin} />
          </Row>
        )}
        {watch !== undefined && (
          <Row label="Watch">
            <span title={watch.firing ? "The watch is firing" : "The watch is green"}>{watch.title}</span>
          </Row>
        )}
        {cost !== undefined && (
          <Row label="Cost">
            <CostText totals={cost} className="text-fg-soft" />
            <span className="tnum"> · {formatTokens(cost.totalTokens)} tokens</span>
          </Row>
        )}
      </dl>
    </Card>
  );
}

/** What the client is told, in four stages: the one it is at is lit and the ones before it are filled. */
function Stages({ view }: { view: IncidentView }) {
  const current = Math.max(
    0,
    view.steps.findIndex((s) => s.status === view.status),
  );
  return (
    <div className="flex flex-col gap-1">
      <ol className="m-0 grid list-none grid-cols-4 gap-1 p-0" aria-label="Where the incident is">
        {view.steps.map((step, i) => (
          <li
            key={step.status}
            aria-hidden="true"
            className={cn(
              "h-[3px] rounded-full",
              i === current ? "bg-lamp-needs" : i < current ? "bg-fg-faint" : "bg-line-strong",
            )}
          />
        ))}
      </ol>
      <ul className="m-0 flex list-none justify-between gap-1 p-0 text-[11px] whitespace-nowrap">
        {view.steps.map((step, i) => (
          <li
            key={step.status}
            className={cn(
              i === current ? "font-medium text-fg" : i < current ? "text-fg-muted" : "text-fg-faint",
            )}
          >
            {CLIENT_STATUS_LABEL[step.status]}
            {i === current && step.at !== undefined ? ` ${clock(step.at)}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

const LAMP: Record<ClientStatus, "needs" | "working" | "done"> = {
  investigating: "needs",
  identified: "needs",
  monitoring: "working",
  resolved: "done",
};

/** What the owner told the client, newest first: "19:15 Investigating". */
export function toldLine(view: IncidentView | null | undefined): string {
  const told = (view?.rooms ?? [])
    .flatMap((r) => (r.toldAt === undefined || r.sees === undefined ? [] : [{ at: r.toldAt, sees: r.sees }]))
    .toSorted((a, b) => (a.at < b.at ? 1 : -1))[0];
  return told === undefined ? "Not yet" : `${clock(told.at)} ${told.sees}`;
}

/**
 * The incident on the task page: its lamp and how long it has been open, the four stages the client is
 * told, the cause, what the client was told and the follow-ups as links.
 */
export function IncidentPanelCard({ task }: { task: Task }) {
  const incident = task.typing?.type === "incident";
  const view = useIncident(task.id, incident).data ?? undefined;
  const list = useTasks().data ?? [];
  const { org } = useOrgFilter();
  const now = useNow(60_000);
  if (!incident || view === undefined) return null;
  const opened = view.steps.find((s) => s.at !== undefined)?.at;
  const followUps = list
    .filter((t) => t.links.some((l) => l.type === "follow-up" && l.task === task.id))
    .toSorted((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return (
    <Card aria-label="Incident" className="gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Lamp state={view.recovered === undefined ? LAMP[view.status] : "working"} size={8} />
        <h2 className="text-sm font-semibold">Incident</h2>
        {opened !== undefined && (
          <span className="text-xs text-fg-faint">open {formatSpan(now - Date.parse(opened))}</span>
        )}
      </div>
      <Stages view={view} />
      <dl className="m-0 flex flex-col">
        <Row label="Cause">{view.report?.internal.cause || "Not found yet"}</Row>
        <Row label="Client">{toldLine(view)}</Row>
        {followUps.length > 0 && (
          <Row label="Follow-ups">
            <span className="flex flex-wrap gap-x-1.5">
              {followUps.map((f, i) => (
                <span key={f.id}>
                  <Link
                    to="/t/$taskId"
                    params={{ taskId: f.id }}
                    search={orgSearch(org)}
                    title={f.title}
                    className="font-mono text-xs text-blue hover:underline"
                  >
                    {f.id}
                  </Link>
                  {i < followUps.length - 1 && <span className="text-fg-faint"> ·</span>}
                </span>
              ))}
            </span>
          </Row>
        )}
      </dl>
    </Card>
  );
}
