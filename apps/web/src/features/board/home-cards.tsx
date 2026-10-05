import { DECISION_KIND_LABEL, type OwnerDecision, type TaskSummary } from "@majhi/shared";
import { Link } from "@tanstack/react-router";
import { memo, type ReactNode } from "react";
import { useRunAttention } from "@/components/shell/banner";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp, type LampState } from "@/components/ui/lamp";
import { useToast } from "@/components/ui/toast";
import { actionOf, openLabel, secretCardOf, workspaceOf } from "@/features/decisions/model";
import { useHeldOption, useSendDecision } from "@/features/decisions/use-send-decision";
import { SecretAnswer } from "@/features/room/secret-answer";
import { useAgentIndex } from "@/lib/agent-index";
import { useCaptainUndo } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { useDecisionDetail } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { useAccounts, useOrgs } from "@/lib/studio-queries";
import { useTaskRow } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { limitNote } from "../shell/limit-note";
import { openDue } from "../tasks/schedule";
import { DueChip, PriorityChip } from "../tasks/schedule-chips";
import { cardLine, plainTitle, queuedText } from "./model";

const FRAME = {
  needs:
    "border-lamp-needs/35 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-needs)_8%,transparent),transparent_60%)]",
  working:
    "border-lamp-working/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-working)_7%,transparent),transparent_60%)]",
  paused:
    "border-lamp-paused/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-paused)_7%,transparent),transparent_60%)]",
  none: "border-glass-line",
} as const;

function Frame({ tone, children }: { tone: keyof typeof FRAME; children: ReactNode }) {
  return (
    <article
      className={cn(
        "group relative flex shrink-0 flex-col gap-1.5 rounded-xl border bg-card p-3 text-base text-fg shadow-glass backdrop-blur-[12px] transition-[transform,border-color] duration-150 hover:-translate-y-px hover:border-line-hover",
        FRAME[tone],
      )}
    >
      {children}
    </article>
  );
}

function OrgChip({ org }: { org: string | undefined }) {
  const orgs = useOrgs().data;
  if (org === undefined) return null;
  const name = orgs?.find((o) => o.id === org)?.name ?? org;
  return (
    <span className="max-w-[45%] shrink-0 truncate rounded-sm border border-line px-1.5 text-xs leading-[18px] text-fg-soft">
      {name}
    </span>
  );
}

function Meta({ org, id, right }: { org: string | undefined; id?: string | undefined; right?: ReactNode }) {
  return (
    <span className="flex h-5 min-w-0 items-center gap-2">
      <OrgChip org={org} />
      {id && <span className="shrink-0 font-mono text-xs text-fg-faint">{id}</span>}
      {right && <span className="ml-auto min-w-0 truncate text-xs text-fg-muted">{right}</span>}
    </span>
  );
}

type Scheduled = Pick<TaskSummary, "repos" | "priority" | "due" | "status">;

/** One quiet line: the project (first, "+1" for more), a non-normal priority, the due date. Nothing to say, no line. */
function TaskMeta({ task }: { task: Scheduled | undefined }) {
  const now = useNow(60_000);
  if (!task) return null;
  const first = task.repos[0]?.project;
  const project =
    first === undefined ? undefined : task.repos.length > 1 ? `${first} +${task.repos.length - 1}` : first;
  const priority = task.priority !== undefined && task.priority !== "normal" ? task.priority : undefined;
  const due = openDue(task, now);
  if (project === undefined && !priority && !due) return null;
  return (
    <span className="flex h-[18px] min-w-0 items-center gap-1.5">
      {project !== undefined && (
        <span title={project} className="min-w-0 flex-1 truncate text-xs text-fg-muted">
          {project}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {priority && <PriorityChip priority={priority} compact />}
        {due && <DueChip due={due} short />}
      </span>
    </span>
  );
}

const COVER =
  "after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-accent";

function TaskTitle({ id, title }: { id: string; title: string }) {
  return (
    <Link
      to="/t/$taskId"
      params={{ taskId: id }}
      search={{}}
      title={title}
      className={cn("line-clamp-3 text-body leading-[1.35] font-medium break-words outline-none", COVER)}
    >
      {title}
    </Link>
  );
}

function StatusLine({ lamp, children }: { lamp: LampState; children: ReactNode }) {
  return (
    <span className={cn("flex items-start gap-2 text-sm", LAMP_TEXT[lamp])}>
      <Lamp state={lamp} size={6} className="mt-[7px]" />
      <span className="min-w-0 text-pretty break-words">{children}</span>
    </span>
  );
}

/** A decision with its answers as buttons; the main one is filled. */
export const DecisionCard = memo(function DecisionCard({ decision }: { decision: OwnerDecision }) {
  const run = useRunAttention();
  const { send: sendDecision, busy } = useSendDecision();
  const held = useHeldOption(decision.id);
  const ship = decision.kind === "ship";
  const detail = useDecisionDetail(ship ? decision.id : undefined).data;
  const task = useTaskRow(decision.task);
  const typed = decision.options.some((o) => o.text === true);
  const options = decision.options.filter((o) => o.text !== true && (!ship || o.primary === true));
  const open = () => run(actionOf(decision.link));
  const send = (option: string) => sendDecision(decision, option);
  const title = ship && decision.taskTitle !== undefined ? decision.taskTitle : decision.title;
  const secret = secretCardOf(decision);
  const showOpen = (options.length === 0 && secret === undefined) || ship || typed;
  return (
    <Frame tone={decision.kind === "paused" ? "paused" : "needs"}>
      <Meta
        org={workspaceOf(decision)}
        id={decision.task}
        right={
          ship ? (decision.blocked === undefined ? "Ready to ship" : "Finished") : DECISION_KIND_LABEL[decision.kind]
        }
      />
      <TaskMeta task={task} />
      <button
        type="button"
        onClick={open}
        title="Open this"
        className={cn(
          "m-0 line-clamp-3 cursor-pointer p-0 text-left text-body leading-[1.35] font-medium break-words outline-none",
          COVER,
        )}
      >
        {plainTitle(title)}
      </button>
      {decision.sentence && !ship && (
        <span className="line-clamp-3 text-sm text-fg-soft text-pretty break-words">{decision.sentence}</span>
      )}
      {decision.blocked !== undefined && (
        <span className="text-sm text-caution text-pretty break-words">{decision.blocked}</span>
      )}
      {detail?.checks && (
        <span className="font-mono text-xs text-green text-pretty break-words">✓ {detail.checks}</span>
      )}
      {secret !== undefined && (
        <SecretAnswer task={secret.task} item={secret.item} label={decision.title} compact />
      )}
      <div className="relative z-10 flex flex-wrap gap-1.5 pt-0.5">
        {options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.primary === true ? "primary" : "secondary"}
            disabled={busy || held !== undefined}
            className="h-auto min-h-7 max-w-full py-1 text-left whitespace-normal"
            onClick={() => send(option.id)}
          >
            {held === option.id ? "Sending..." : option.label}
          </Button>
        ))}
        {showOpen && (
          <Button size="sm" variant={options.length === 0 ? "primary" : "secondary"} onClick={open}>
            {ship ? "Look first" : decision.kind === "question" && options.length === 0 ? "Answer in the task" : openLabel(decision.link)}
          </Button>
        )}
      </div>
    </Frame>
  );
});

/** A task that runs or is paused: the live line, the lead and its age. */
export const WorkingCard = memo(function WorkingCard({ task, ago }: { task: TaskSummary; ago: string }) {
  const agents = useAgentIndex();
  const accounts = useAccounts().data;
  const line = cardLine(task);
  const paused = task.status === "paused";
  let text = line?.text ?? "";
  if (paused && task.pausedReason === "limit") {
    for (const id of task.team) {
      const account = agents.get(id)?.account;
      const note = limitNote(
        accounts?.find((a) => a.id === account),
        Date.now(),
      );
      if (note?.full && account) {
        text = `Paused: ${account} is at its limit${note.text.replace("At limit", "")}`;
        break;
      }
    }
  }
  const lead = (paused ? task.team : task.working)[0];
  return (
    <Frame tone={paused ? "paused" : "working"}>
      <Meta org={task.org} id={task.id} />
      <TaskMeta task={task} />
      <TaskTitle id={task.id} title={plainTitle(task.title)} />
      {line && <StatusLine lamp={line.lamp}>{text}</StatusLine>}
      <span className="flex items-center gap-2 text-xs text-fg-muted">
        {task.children && `${task.children.done} of ${task.children.total} done`}
        <span className="ml-auto truncate font-mono">
          {lead ? `@${lead} · ` : ""}
          {ago}
        </span>
      </span>
    </Frame>
  );
});

export const QueuedCard = memo(function QueuedCard({ task }: { task: TaskSummary }) {
  const text = queuedText(task);
  return (
    <Frame tone="none">
      <Meta org={task.org} id={task.id} />
      <TaskMeta task={task} />
      <TaskTitle id={task.id} title={plainTitle(task.title)} />
      <span className="text-sm text-fg-faint">{text}</span>
    </Frame>
  );
});

export const DoneCard = memo(function DoneCard({
  task,
  time,
  undoId,
}: {
  task: TaskSummary;
  time: string;
  /** The captain action that merged it, when Undo works on it. */
  undoId: number | undefined;
}) {
  const undo = useCaptainUndo();
  const toast = useToast();
  return (
    <Frame tone="none">
      <Meta org={task.org} id={task.id} />
      <TaskMeta task={task} />
      <TaskTitle id={task.id} title={plainTitle(task.title)} />
      <span className="flex items-center gap-2 text-sm text-fg-faint">
        <span>
          {undoId !== undefined ? "Merged by the captain" : "Done"} ·{" "}
          <span className="font-mono">{time}</span>
        </span>
        {undoId !== undefined && (
          <button
            type="button"
            disabled={undo.isPending}
            onClick={() =>
              undo.mutate(
                { id: undoId },
                {
                  onSuccess: (done) => toast("Undone", { detail: done.detail }),
                  onError: (error) =>
                    toast("Could not undo it", { detail: describeError(error), tone: "error" }),
                },
              )
            }
            className="relative z-10 ml-auto cursor-pointer text-accent-text hover:underline disabled:opacity-50"
          >
            Undo
          </button>
        )}
      </span>
    </Frame>
  );
});
