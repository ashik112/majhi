import type { AgentLive, RoomItem } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import {
  Brain,
  Check,
  ChevronRight,
  CircleAlert,
  GitCompareArrows,
  ListChecks,
  Paperclip,
  ShieldQuestion,
  TriangleAlert,
} from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { TaskRefText } from "@/features/task-drawer/task-ref";
import { linkifyPaths } from "@/features/viewer/model";
import { useAgentIndex } from "@/lib/agent-index";
import { type ApiRequestError, cmd } from "@/lib/api";
import { cn } from "@/lib/cn";
import { ApprovalCard, SecretRequestCard } from "./approval-card";
import { DOCK_ACTIONS } from "./dock";
import { Markdown } from "./markdown";
import { MediaView, TaskFileLink, type TaskFiles } from "./media";
import { contextLine, permissionOptionLabel, permissionSummary, toolLabel } from "./model";
import { type OwnerContext, PausedCard, QuestionActions, ReviewCard } from "./owner-cards";
import { ownerNotice, type Quiet, valueParts } from "./system-lines";
import { ToolRow } from "./tool-row";

/** The inset of everything that is not a message: it lines up with the text beside the avatars. */
export const GUTTER = "pl-[34px]";

/** A message's text column: a readable measure. */
const MEASURE = "max-w-[72ch]";

export function permissionDomId(itemId: string): string {
  return `perm-${itemId}`;
}

/** The id of a log row, so a search match can scroll to it. `key` is the row's key (the item id, or the first note of a folded line). */
export function rowDomId(key: string): string {
  return `room-row-${key}`;
}

type Of<T extends RoomItem["type"]> = Extract<RoomItem, { type: T }>;

export interface ItemContext {
  /** Ids of plan items shown pinned at the top, which the timeline skips. */
  pinned: ReadonlySet<string>;
  onPermission: (item: string, option: string) => void;
  answering: string | undefined;
  /** The task, so agent text can link to its files. */
  task: TaskFiles;
}

/** Item types that act on the whole task, and so get the owner context. The others never see it, so a change to the task does not redraw them. */
export const OWNER_CARD_TYPES: ReadonlySet<RoomItem["type"]> = new Set([
  "review",
  "paused",
  "owner-question",
]);

/** One room item. Wrapped so a long room paints only what is on screen. */
export const RoomItemView = memo(function RoomItemView({
  item,
  ctx,
  liveModel,
  owner,
  className,
  inLog = false,
}: {
  item: RoomItem;
  ctx: ItemContext;
  /** The model its agent runs, for an agent message. A string, so the row stays as it is while the agent's status changes. */
  liveModel?: string | undefined;
  /** The whole task and the room's hooks, for the review, paused and question cards only. */
  owner?: OwnerContext | undefined;
  /** Drawn in the log (not the "Needs you" dock), so it carries a row id. */
  inLog?: boolean;
  /** The space above it, from the row before. */
  className?: string | undefined;
}) {
  if (item.type === "plan" && ctx.pinned.has(item.id)) return null;
  return (
    <li
      {...(inLog ? { id: rowDomId(item.id) } : {})}
      className={cn(
        "animate-fade-in list-none [contain-intrinsic-size:auto_40px] [content-visibility:auto]",
        className,
      )}
    >
      <ItemBody item={item} ctx={ctx} liveModel={liveModel} owner={owner} />
    </li>
  );
});

/** System notes posted in one moment, as one quiet line. */
export const NotesRow = memo(function NotesRow({
  quiet,
  at,
  rowKey,
  className,
}: {
  quiet: Quiet;
  at: string;
  rowKey: string;
  className?: string | undefined;
}) {
  return (
    <li id={rowDomId(rowKey)} className={cn("animate-fade-in list-none", className)}>
      <QuietLine quiet={quiet} at={at} />
    </li>
  );
});

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** When an item was posted: small, and on hover only for quiet lines. */
function Stamp({ at, hover }: { at: string; hover?: boolean }) {
  return (
    <time
      dateTime={at}
      title={new Date(at).toLocaleString()}
      className={cn(
        "tnum shrink-0 font-mono text-xs text-fg-dim",
        hover && "opacity-0 transition-opacity duration-150 group-hover/line:opacity-100",
      )}
    >
      {clock(at)}
    </time>
  );
}

/** Text with backticked values in mono, and task ids and @mentions as links. */
function QuietText({ text }: { text: string }) {
  return valueParts(text).map((part, i) =>
    part.value ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line keep their order
      <span key={i} className="font-mono text-fg-muted">
        {part.text}
      </span>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one line keep their order
      <TaskRefText key={i} text={part.text} />
    ),
  );
}

const QUIET_TONE = {
  info: "text-fg-faint",
  warn: "text-amber",
  error: "text-red",
} as const;

/**
 * One quiet line in the log, left aligned at the gutter: a short sentence, the full text behind a
 * small expander when there is more, and the time on hover. Warnings and errors wrap instead of
 * cutting, so the whole of what went wrong shows.
 */
export function QuietLine({
  quiet,
  at,
  tone = "info",
  icon,
  children,
}: {
  quiet: Quiet;
  at?: string | undefined;
  tone?: keyof typeof QUIET_TONE;
  icon?: ReactNode;
  /** More to show under the line when it is opened, in place of the plain detail text. */
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const more = children !== undefined || quiet.detail !== undefined;
  const plain = quiet.short.replaceAll("`", "");
  return (
    <div className={cn(GUTTER, "group/line flex flex-col")}>
      <div
        role={tone === "error" ? "alert" : undefined}
        className={cn("flex min-h-5 items-start gap-1.5 text-sm", QUIET_TONE[tone])}
      >
        <span aria-hidden="true" className="grid h-[18px] w-3.5 shrink-0 place-items-center">
          {icon ?? <span className="size-1 rounded-full bg-current opacity-70" />}
        </span>
        <p
          title={tone === "info" ? plain : undefined}
          className={cn("min-w-0", tone === "info" ? "truncate" : "text-pretty break-words")}
        >
          <QuietText text={quiet.short} />
        </p>
        {more && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide details" : "Show details"}
            title={open ? "Hide details" : "Show details"}
            onClick={() => setOpen((v) => !v)}
            className="grid size-[18px] shrink-0 cursor-pointer place-items-center rounded-xs text-fg-faint hover:bg-raised hover:text-fg"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-3 transition-transform duration-150", open && "rotate-90")}
            />
          </button>
        )}
        {at !== undefined && (
          <span className="ml-auto pl-3">
            <Stamp at={at} hover />
          </span>
        )}
      </div>
      {open &&
        (children ?? (
          <p
            className={cn(
              MEASURE,
              "mt-1 mb-1 ml-5 rounded-md bg-sunken px-2.5 py-1.5 text-sm leading-[1.6] whitespace-pre-wrap break-words text-fg-muted",
            )}
          >
            <QuietText text={quiet.detail ?? ""} />
          </p>
        ))}
    </div>
  );
}

function ItemBody({
  item,
  ctx,
  liveModel,
  owner,
}: {
  item: RoomItem;
  ctx: ItemContext;
  liveModel: string | undefined;
  owner: OwnerContext | undefined;
}) {
  switch (item.type) {
    case "owner":
      return <OwnerMessage item={item} />;
    case "agent":
      return <AgentMessage item={item} model={liveModel} task={ctx.task} />;
    case "thought":
      return <Thought item={item} />;
    case "tool":
      return <ToolRow item={item} folder={ctx.task.folder} />;
    case "plan":
      return <PlanSummary item={item} />;
    case "permission":
      return <Permission item={item} onAnswer={ctx.onPermission} busy={ctx.answering === item.id} />;
    case "approval":
      return <ApprovalCard item={item} />;
    case "secret-request":
      return <SecretRequestCard item={item} />;
    case "ask":
      return <AskCard item={item} />;
    case "choice":
      return <ChoiceCard item={item} />;
    case "system":
      return <SystemLine item={item} />;
    case "context":
      return <ContextLine item={item} />;
    case "handoff":
      return <HandoffLine item={item} />;
    case "team-plan":
      return <TeamPlanLine item={item} />;
    case "review":
      return <ReviewCard item={item} owner={owner} />;
    case "paused":
      return <PausedCard item={item} owner={owner} />;
    case "owner-question":
      return <QuestionActions item={item} owner={owner} />;
  }
}

const HANDOFF_WORDS: Record<Of<"handoff">["via"], string> = {
  mention: "handed to",
  tool: "handed to",
  pipeline: "finished, next step:",
  "review-loop": "passed the work to",
  guard: "woke",
};

/**
 * One agent woke another (5.3), as a quiet line. A mention's message is the agent's above it; work
 * handed over by the tool shows its first line, and all of it when opened.
 */
function HandoffLine({ item }: { item: Of<"handoff"> }) {
  const head = `@${item.from} ${HANDOFF_WORDS[item.via]} @${item.to}${item.queued ? ", after its current turn" : ""}`;
  if (item.via !== "tool" || item.text.trim() === "")
    return <QuietLine quiet={{ short: head }} at={item.at} />;
  const first = item.text.trim().split("\n", 1)[0] ?? "";
  return (
    <QuietLine quiet={{ short: `${head}: ${first}`, detail: item.text }} at={item.at}>
      <div
        className={cn(
          MEASURE,
          "mt-1 mb-1 ml-5 rounded-md bg-sunken px-3 py-2 text-base leading-[1.6] text-fg-soft",
        )}
      >
        <Markdown text={item.text} />
      </div>
    </QuietLine>
  );
}

/** The lead's plan (`record_plan`) as one quiet line; opened, the steps, why, and how the work gets done. */
function TeamPlanLine({ item }: { item: Of<"team-plan"> }) {
  const name = item.version > 1 ? `Plan v${item.version}` : "Plan";
  const steps = item.steps.map((s, i) => `${i + 1}. ${s.who} ${s.what}`).join(" · ");
  return (
    <QuietLine
      quiet={{ short: `${name}: ${steps}`, detail: item.why }}
      at={item.at}
      icon={<ListChecks className="size-3.5" />}
    >
      <div
        className={cn(MEASURE, "mt-1 mb-1 ml-5 flex flex-col gap-1.5 rounded-md bg-sunken px-3 py-2 text-sm")}
      >
        <ol className="m-0 flex list-none flex-col gap-0.5 p-0 text-fg-soft">
          {item.steps.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps of one plan keep their order
            <li key={i}>
              <span className="tnum font-mono text-fg-faint">{i + 1}.</span>{" "}
              <TaskRefText text={`${step.who} ${step.what}`} />
            </li>
          ))}
        </ol>
        <p className="text-fg-muted text-pretty">{item.why}</p>
        {item.how.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {item.how.map((h) => (
              <span key={h} className="rounded-xs border border-line px-1 font-mono text-xs text-fg-faint">
                {h}
              </span>
            ))}
          </p>
        )}
      </div>
    </QuietLine>
  );
}

/** A compaction, as one quiet line, with the handoff note when there is one. */
function ContextLine({ item }: { item: Of<"context"> }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0">
        <QuietLine quiet={{ short: contextLine(item) }} at={item.at} />
      </div>
      {item.note && <TaskFileLink path={item.note} kind="markdown" label="note" />}
    </div>
  );
}

/** The owner's side of the conversation: a light bubble in the same column as the agents. */
function OwnerMessage({ item }: { item: Of<"owner"> }) {
  // What majhi once wrote as the owner (an approval, a choice) reads as the plain line it is.
  const notice = ownerNotice(item);
  if (notice) return <QuietLine quiet={notice} at={item.at} />;
  return (
    <article aria-label="You" className="flex gap-2.5">
      <span
        aria-hidden="true"
        className="flex size-6 shrink-0 items-center justify-center rounded-full bg-fg-soft text-[10px] font-semibold text-canvas"
      >
        Y
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 items-center gap-2">
          <span className="text-base font-semibold text-fg">You</span>
          <Stamp at={item.at} />
          {item.queued && <span className="text-sm text-fg-faint">Queued for the agent's next turn</span>}
        </div>
        <div
          className={cn(
            MEASURE,
            "w-fit rounded-lg bg-raised px-3 py-2 text-body whitespace-pre-wrap break-words text-fg",
            item.queued && "opacity-70",
          )}
        >
          <TaskRefText text={item.text} />
        </div>
        {item.attachments.length > 0 && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
            {item.attachments.map((a) => (
              <li
                key={a.id}
                className="flex h-6 items-center gap-1 rounded-sm border border-line-strong px-1.5 font-mono text-xs text-fg-muted"
              >
                <Paperclip aria-hidden="true" className="size-3" />
                {a.name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

/** An agent's message: avatar, handle and model, then its text unboxed at a readable measure. */
function AgentMessage({
  item,
  model,
  task,
}: {
  item: Of<"agent">;
  model: string | undefined;
  task: TaskFiles;
}) {
  const info = useAgentIndex().get(item.agent);
  const meta = [info?.account, model ?? info?.model].filter(Boolean).join(" · ");
  return (
    <article aria-label={`@${item.agent}`} className="flex gap-2.5">
      <AgentAvatar id={item.agent} size={24} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex h-6 min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-base font-semibold text-fg">@{item.agent}</span>
          {meta && <span className="min-w-0 truncate font-mono text-xs text-fg-faint">{meta}</span>}
          <Stamp at={item.at} />
        </div>
        {item.text !== "" && (
          <div className={cn(MEASURE, "min-w-0 text-body text-fg")}>
            <Markdown text={task === undefined ? item.text : linkifyPaths(item.text)} task={task} />
          </div>
        )}
        {item.media !== undefined && item.media.length > 0 && (
          <ul aria-label="Attached media" className="m-0 flex list-none flex-col items-start gap-2 p-0">
            {item.media.map((m) => (
              <li key={`${m.kind}:${m.src}`} className="max-w-full">
                <MediaView media={m} onLoad={task.onLoad} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function Thought({ item }: { item: Of<"thought"> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={GUTTER}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1.5 flex h-6 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-sm text-fg-faint hover:bg-raised hover:text-fg-muted"
      >
        <Brain aria-hidden="true" className="size-3.5" />
        Thinking
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform", open && "rotate-90")} />
      </button>
      {open && (
        <p
          className={cn(
            MEASURE,
            "mt-1 mb-1 rounded-md bg-sunken px-3 py-2 text-base whitespace-pre-wrap break-words text-fg-muted",
          )}
        >
          <TaskRefText text={item.text} />
        </p>
      )}
    </div>
  );
}

function PlanSummary({ item }: { item: Of<"plan"> }) {
  const done = item.entries.filter((e) => e.status === "completed").length;
  return (
    <details className={cn(GUTTER, "text-sm text-fg-faint")}>
      <summary className="flex cursor-pointer items-center gap-1.5 hover:text-fg-muted">
        <ListChecks aria-hidden="true" className="size-3.5" />
        Plan, {done} of {item.entries.length} done
      </summary>
      <PlanList entries={item.entries} />
    </details>
  );
}

function PlanList({ entries }: { entries: Of<"plan">["entries"] }) {
  return (
    <ul className="mt-1.5 flex flex-col gap-1">
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: plan entries have no id and keep their order
        <li key={i} className="flex items-start gap-2 text-base">
          <span
            aria-hidden="true"
            className={cn(
              "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-xs border text-[9px] leading-none",
              entry.status === "completed" && "border-green-line bg-green-wash text-green",
              entry.status === "in_progress" && "border-lamp-working/50 text-lamp-working",
              entry.status === "pending" && "border-line-control",
            )}
          >
            {entry.status === "completed" ? (
              <Check className="size-2.5" strokeWidth={3} />
            ) : entry.status === "in_progress" ? (
              <span className="size-1.5 rounded-full bg-current" />
            ) : null}
          </span>
          <span className={cn(entry.status === "completed" ? "text-fg-faint line-through" : "text-fg-soft")}>
            {entry.content}
            <span className="sr-only"> ({entry.status.replace("_", " ")})</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The agent's plan as a checklist, pinned above the room while it has open entries. */
export function PinnedPlan({ plan }: { plan: Of<"plan"> }) {
  const done = plan.entries.filter((e) => e.status === "completed").length;
  return (
    <section
      aria-label={`Plan of ${plan.agent}`}
      className="rounded-lg border border-line-strong bg-card px-3 py-2.5"
    >
      <h3 className="flex items-center gap-2 text-xs font-normal tracking-[0.08em] text-fg-faint uppercase">
        <ListChecks aria-hidden="true" className="size-3.5" />
        Plan
        <span className="font-mono normal-case tracking-normal">
          {done} of {plan.entries.length}
        </span>
      </h3>
      <PlanList entries={plan.entries} />
    </section>
  );
}

function Permission({
  item,
  onAnswer,
  busy,
}: {
  item: Of<"permission">;
  onAnswer: (item: string, option: string) => void;
  busy: boolean;
}) {
  const summary = permissionSummary(item);
  if (!summary.pending) {
    return (
      <details className="group pl-[34px] text-sm text-fg-faint">
        <summary
          className={cn(
            "-ml-1.5 flex h-6 list-none items-center gap-1.5 rounded-sm px-1.5",
            summary.full ? "cursor-pointer hover:text-fg-muted" : "pointer-events-none",
          )}
        >
          <ShieldQuestion aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="shrink-0">{summary.verdict}</span>
          <code className="min-w-0 truncate font-mono text-xs">{summary.short}</code>
        </summary>
        {summary.full && (
          <pre className="mt-1.5 max-h-72 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-xs whitespace-pre-wrap text-fg-soft">
            {summary.full}
          </pre>
        )}
      </details>
    );
  }
  return (
    <section
      id={permissionDomId(item.id)}
      tabIndex={-1}
      aria-label={`Permission: ${item.title}`}
      className="flex max-w-[72ch] outline-none flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">
          <span className="text-fg-muted">{item.agent} asks to </span>
          <span className="text-sm">{toolLabel(item.title)}</span>
        </span>
      </p>
      <div className={cn(DOCK_ACTIONS, "flex flex-wrap gap-2")}>
        {item.options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={option.kind === "allow_once" ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => onAnswer(item.id, option.id)}
          >
            {permissionOptionLabel(option)}
          </Button>
        ))}
      </div>
    </section>
  );
}

/** A real trade-off for the owner, with the choices spelled out. Settled: one quiet line. */
function ChoiceCard({ item }: { item: Of<"choice"> }) {
  const toast = useToast();
  const choose = useMutation<unknown, ApiRequestError, string>({
    mutationFn: (option) => cmd("room.choose", { task: item.task, item: item.id, option }),
    onError: (error) => toast("Could not answer", { detail: error.message, tone: "error" }),
  });
  if (item.state !== "pending") {
    const label = item.options.find((o) => o.id === item.chosen)?.label;
    return (
      <QuietLine
        quiet={{
          short: label === undefined ? `Not answered: ${item.question}` : `You chose: ${label}`,
          detail: item.question,
        }}
        at={item.at}
        icon={<GitCompareArrows className="size-3.5" />}
      />
    );
  }
  return (
    <section
      aria-label="Choice"
      className="flex max-w-[72ch] flex-col gap-2.5 rounded-lg border border-amber-line bg-amber-wash px-3.5 py-3"
    >
      <p className="flex items-start gap-2 text-base text-fg">
        <GitCompareArrows aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber" />
        <span className="min-w-0 break-words">{item.question}</span>
      </p>
      <div className={cn(DOCK_ACTIONS, "flex flex-wrap gap-2")}>
        {item.options.map((option, i) => (
          <Button
            key={option.id}
            size="sm"
            variant={i === 0 ? "primary" : "secondary"}
            disabled={choose.isPending}
            onClick={() => choose.mutate(option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

function AskCard({ item }: { item: Of<"ask"> }) {
  const toast = useToast();
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const initial = item.answers ?? {};
    for (const q of item.questions) {
      if (!(q.id in initial) && q.default) {
        initial[q.id] = q.default;
      }
    }
    return initial;
  });
  const [answeredVia, setAnsweredVia] = useState<Record<string, "option" | "text">>(() => {
    const via: Record<string, "option" | "text"> = {};
    for (const q of item.questions) {
      const ans = answers[q.id];
      if (ans) {
        via[q.id] = q.options.some((o) => o.id === ans) ? "option" : "text";
      }
    }
    return via;
  });

  const answer = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("room.answerAsk", { task: item.task, item: item.id, answers }),
    onError: (error) => toast("Could not answer", { detail: error.message, tone: "error" }),
  });

  if (item.state !== "pending") {
    return (
      <div className="flex flex-col gap-0.5">
        {item.questions.map((q) => {
          const answer = item.answers?.[q.id];
          const option = q.options.find((o) => o.id === answer);
          const label = option?.label ?? answer;
          const verb = option === undefined ? "typed" : "chose";
          return (
            <QuietLine
              key={q.id}
              quiet={{
                short: label === undefined ? `Not answered: ${q.question}` : `You ${verb}: ${label}`,
                detail: q.question,
              }}
              at={item.at}
              icon={<ListChecks className="size-3.5" />}
            />
          );
        })}
      </div>
    );
  }

  const handleOptionClick = (questionId: string, optionId: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: optionId }));
    setAnsweredVia((prev) => ({ ...prev, [questionId]: "option" }));
  };

  const handleTextChange = (questionId: string, text: string) => {
    setAnswers((prev) => ({ ...prev, [questionId]: text }));
    setAnsweredVia((prev) => ({ ...prev, [questionId]: "text" }));
  };

  return (
    <section
      aria-label="Question"
      className="flex max-w-[72ch] flex-col gap-3 rounded-lg border border-blue-line bg-blue-wash px-3.5 py-3"
    >
      {item.questions.map((question) => (
        <div key={question.id} className="flex flex-col gap-2">
          <p className="flex items-start gap-2 text-base text-fg">
            <ShieldQuestion aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-blue" />
            <span className="min-w-0 break-words">{question.question}</span>
          </p>
          {question.options.length === 0 && question.freeText ? (
            <input
              type="text"
              placeholder="Type your answer..."
              value={answers[question.id] ?? ""}
              onChange={(e) => handleTextChange(question.id, e.target.value)}
              disabled={answer.isPending}
              className="rounded-md border border-line-control bg-field px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50"
            />
          ) : question.options.length <= 4 ? (
            <>
              <div className="flex flex-wrap gap-2">
                {question.options.map((option) => (
                  <Button
                    key={option.id}
                    size="sm"
                    variant={answers[question.id] === option.id ? "primary" : "secondary"}
                    disabled={answer.isPending}
                    onClick={() => handleOptionClick(question.id, option.id)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              {question.freeText && answeredVia[question.id] !== "option" && (
                <input
                  type="text"
                  placeholder="Or type your own..."
                  value={answeredVia[question.id] === "text" ? (answers[question.id] ?? "") : ""}
                  onChange={(e) => handleTextChange(question.id, e.target.value)}
                  disabled={answer.isPending}
                  className="rounded-md border border-line-control bg-field px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50"
                />
              )}
            </>
          ) : (
            <>
              <select
                value={answers[question.id] ?? ""}
                onChange={(e) => handleOptionClick(question.id, e.target.value)}
                disabled={answer.isPending}
                className="rounded-md border border-line-control bg-field px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none disabled:opacity-50"
              >
                <option value="">Select an option...</option>
                {question.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {question.freeText && answeredVia[question.id] !== "option" && (
                <input
                  type="text"
                  placeholder="Or type your own..."
                  value={answeredVia[question.id] === "text" ? (answers[question.id] ?? "") : ""}
                  onChange={(e) => handleTextChange(question.id, e.target.value)}
                  disabled={answer.isPending}
                  className="rounded-md border border-line-control bg-field px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none disabled:opacity-50"
                />
              )}
            </>
          )}
        </div>
      ))}
      <Button
        size="sm"
        variant="primary"
        disabled={answer.isPending || !item.questions.every((q) => q.id in answers)}
        onClick={() => answer.mutate()}
        className="self-start"
      >
        {answer.isPending ? "Sending..." : "Send"}
      </Button>
    </section>
  );
}

const SYSTEM_ICON = {
  warn: <TriangleAlert className="size-3.5" />,
  error: <CircleAlert className="size-3.5" />,
};

/** A warning or an error from majhi. Plain notes come grouped as a NotesRow instead. */
function SystemLine({ item }: { item: Of<"system"> }) {
  return (
    <QuietLine
      quiet={{ short: item.text }}
      at={item.at}
      tone={item.level}
      icon={item.level === "info" ? undefined : SYSTEM_ICON[item.level]}
    />
  );
}
