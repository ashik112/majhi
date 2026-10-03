import type { Task, TaskSummary } from "@majhi/shared";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { OrgBadge } from "@/components/ui/org-badge";
import { SectionLabel } from "@/components/ui/section-label";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Markdown } from "@/features/room/markdown";
import { briefBody, relations } from "@/features/task/model";
import { statusInfo } from "@/features/tasks/model";
import { cn } from "@/lib/cn";
import { badgeLetters, formatAgo } from "@/lib/format";
import { useLaneRedirect } from "@/lib/lane-link";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useOrgs } from "@/lib/studio-queries";
import { useTask, useTasks } from "@/lib/task-queries";
import type { AppSearch } from "@/router";
import { TaskRef } from "./task-ref";

/**
 * A task's details in a drawer over any page, opened by `?task=<id>` from a task id in a message.
 * Ids in the drawer switch it to that task; "Open task" goes to the task itself.
 */
export function TaskDrawer({ id }: { id: string }) {
  const navigate = useNavigate();
  const close = () =>
    navigate({
      to: ".",
      search: (prev: AppSearch) => {
        const { task: _open, ...rest } = prev;
        return rest;
      },
    });
  return (
    <Modal
      label={`Task ${id}`}
      onClose={close}
      className="fixed top-3 right-3 bottom-3 left-auto m-0 h-[calc(100dvh-24px)] max-h-none w-[min(560px,100vw)] max-w-[calc(100vw-24px)] flex-col open:flex rounded-2xl"
    >
      <Details key={id} id={id} onClose={close} />
    </Modal>
  );
}

function Details({ id, onClose }: { id: string; onClose: () => void }) {
  const task = useTask(id);
  const list = useTasks().data ?? [];
  const summary = list.find((t) => t.id === id);
  const { org: filter } = useOrgFilter();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-line-strong px-5 pt-3.5 pb-3">
        <div className="flex items-center gap-2.5 text-sm">
          <span className="font-mono text-fg-muted">{id}</span>
          {task.data && <Status task={task.data} summary={summary} />}
          {task.data && <Org task={task.data} />}
          <span className="flex-1" />
          {task.data && (
            <Button asChild size="sm" variant="secondary">
              <Link to="/t/$taskId" params={{ taskId: id }} search={orgSearch(filter)}>
                <ArrowUpRight aria-hidden="true" />
                Open task
              </Link>
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Close task details" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        {task.data ? (
          <h2 className="text-lg leading-snug font-semibold text-pretty">{task.data.title}</h2>
        ) : task.isError ? (
          <h2 className="text-lg leading-snug font-semibold">Could not open {id}</h2>
        ) : (
          <Skeleton className="h-6 w-2/3" />
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-4 pb-6 scroll-fade">
        {task.data ? (
          <Body task={task.data} list={list} />
        ) : task.isError ? (
          <p className="text-base text-fg-muted text-pretty">{task.error.message}</p>
        ) : (
          <div role="status" aria-busy="true" aria-label={`Loading ${id}`} className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-20 w-full rounded-lg" />
          </div>
        )}
      </div>
    </div>
  );
}

function Status({ task, summary }: { task: Task; summary: TaskSummary | undefined }) {
  // Running with no agent at work means the task waits for the owner, as on the board.
  const yourTurn = task.status === "running" && summary !== undefined && summary.working.length === 0;
  return (
    <StatusBadge
      status={task.status}
      pausedReason={task.pausedReason}
      pausedBy={task.pausedBy}
      yourTurn={yourTurn}
    />
  );
}

function Org({ task }: { task: Task }) {
  const org = useOrgs().data?.find((o) => o.id === task.org);
  const prefix = task.id.slice(0, task.id.lastIndexOf("-"));
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
      <OrgBadge label={badgeLetters(org?.key ?? prefix)} color={org?.color} size="sm" />
      <span className="truncate">{org?.name ?? "No workspace"}</span>
    </span>
  );
}

function Body({ task, list }: { task: Task; list: readonly TaskSummary[] }) {
  const rel = relations(task, list);
  const brief = briefBody(task.brief, task.title);
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-5 gap-y-2 text-base">
        <Row label="Project">
          {task.repos.length > 0 ? (
            <ul className="flex flex-col gap-0.5">
              {task.repos.map((r) => (
                <li key={r.project} className="font-mono text-sm">
                  <span className="text-fg-soft">{r.project}</span>
                  <span className="text-fg-faint"> on </span>
                  <span className="break-all text-fg-muted">{r.branch}</span>
                  <span className="text-fg-faint"> from </span>
                  <span className="text-fg-soft">{r.base}</span>
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-fg-faint">{task.kind === "chat" ? "Chat, no project" : "No project"}</span>
          )}
        </Row>
        {task.team.length > 0 && (
          <Row label={task.team.length === 1 ? "Agent" : "Agents"}>
            <ul className="flex flex-wrap gap-x-3 gap-y-1">
              {task.team.map((agent) => (
                <li key={agent} className="flex items-center gap-1.5 font-mono text-sm text-fg-soft">
                  <AgentAvatar id={agent} size={18} decorative />@{agent}
                </li>
              ))}
            </ul>
          </Row>
        )}
        {rel.parent && (
          <Row label="Part of">
            <Linked id={rel.parent.id} title={rel.parent.title} />
          </Row>
        )}
        {rel.depends.length > 0 && (
          <Row label="Waits for">
            <ul className="flex flex-col gap-0.5">
              {rel.depends.map((d) => (
                <li key={d.id} className="flex items-baseline gap-1.5">
                  <Linked id={d.id} title={d.title} />
                  <span className={cn("shrink-0 text-xs", d.waiting ? "text-coral" : "text-green")}>
                    {d.waiting ? (
                      `until ${d.when === "ready" ? "ready for review" : "done"}`
                    ) : (
                      <Check aria-label="met" className="inline size-3" />
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Row>
        )}
        {rel.children.length > 0 && (
          <Row label="Subtasks">
            <ul className="flex flex-col gap-0.5">
              {rel.children.map((c) => (
                <li key={c.id} className="flex items-baseline gap-1.5">
                  <Linked id={c.id} title={c.title} />
                  <span className="shrink-0 text-xs text-fg-faint">{statusInfo(c.status).label}</span>
                </li>
              ))}
            </ul>
          </Row>
        )}
        <Row label="Updated">
          <span className="text-fg-muted" title={new Date(task.updatedAt).toLocaleString()}>
            {formatAgo(task.updatedAt, Date.now())}
          </span>
        </Row>
      </dl>
      {brief !== "" && (
        <section aria-label="Task brief" className="flex flex-col gap-1.5">
          <SectionLabel>Brief</SectionLabel>
          <Markdown text={brief} />
        </section>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-sm text-fg-faint">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Linked({ id, title }: { id: string; title: string | undefined }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
      <TaskRef id={id} />
      {title && <span className="truncate text-fg-muted">{title}</span>}
    </span>
  );
}
