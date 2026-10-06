import { type AgentLive, PAGE_PATH, type RoomItem, type SkillRun, type Task } from "@majhi/shared";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, FileText } from "lucide-react";
import { type ReactNode, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Markdown } from "@/features/room/markdown";
import { hitRateText, TaskReceiptView } from "@/features/usage/receipt-view";
import { useFileText } from "@/features/viewer/use-task-file";
import { type ApiRequestError, cmd } from "@/lib/api";
import { useSettings } from "@/lib/boss-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, formatTokens, plural } from "@/lib/format";
import { useSkillRuns } from "@/lib/skills-queries";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { useTaskReceipt } from "@/lib/usage-queries";
import { useNow } from "@/lib/use-now";
import { CostText } from "../usage/cost";
import {
  type ContextEvent,
  contextHistory,
  EVENT_WORDS,
  filesRead,
  type MeterTone,
  meterTone,
  roomMessages,
} from "./context-model";
import { agentDot } from "./model";

/** The compact threshold majhi uses when nothing else is set (SPEC 5.13). */
const DEFAULT_COMPACT_AT = 0.8;

/** Files read listed before "Show all". */
const FILES_SHOWN = 6;

type ReceiptQuery = ReturnType<typeof useTaskReceipt>;

/** How an attachment reaches the team, in a few words. */
function attachmentUse(a: Task["attachments"][number]): string {
  if (a.kind === "link")
    return a.error !== undefined ? `Not fetched: ${a.error}` : "Fetched and summarized once";
  if (a.kind === "image") return "Sent with the first message";
  return "Named by path in the brief";
}

/**
 * The Context tab (SPEC 3.1, 5.13): how full each agent's context is, what is in it, and when it was
 * compacted or moved to a fresh session. The raw brief and the token receipt open on demand.
 */
export function ContextTab({
  task,
  agents,
  items,
}: {
  task: Task;
  agents: readonly AgentLive[];
  items: readonly RoomItem[];
}) {
  const receipt = useTaskReceipt(task.id);
  const entries = useAgents().data ?? [];
  const org = useOrgs().data?.find((o) => o.id === task.org);
  const settings = useSettings().data;
  const now = useNow(30_000);
  const base = org?.context?.compact_at ?? settings?.context.compact_at ?? DEFAULT_COMPACT_AT;
  const compactAt = (id: string) => {
    const entry = entries.find((e) => e.status === "ok" && e.agent.frontmatter.id === id);
    return (entry?.status === "ok" ? entry.agent.frontmatter.context?.compact_at : undefined) ?? base;
  };
  const history = contextHistory(receipt.data?.compactions ?? [], items);

  return (
    <section
      aria-label="Context of this task"
      className="@container flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain pr-1 pb-3 scroll-fade"
    >
      <Card aria-labelledby="context-agents-heading" className="shrink-0 gap-1 px-4 py-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id="context-agents-heading" className="shrink-0 text-sm font-semibold">
            Context of each agent
          </h2>
          <span
            className="min-w-0 truncate text-xs text-fg-faint"
            title="When compacting is not enough, the agent moves to a fresh session with a handoff note"
          >
            Compacts at {Math.round(base * 100)}%
          </span>
        </div>
        {task.team.length === 0 ? (
          <p className="m-0 py-2 text-sm text-fg-faint">No agent yet.</p>
        ) : (
          <ul aria-label="Context of each agent" className="m-0 flex list-none flex-col p-0">
            {task.team.map((id) => (
              <AgentContext
                key={id}
                task={task.id}
                id={id}
                live={agents.find((a) => a.agent === id)}
                compactAt={compactAt(id)}
                base={base}
                last={history.find((e) => e.agent === id)}
                now={now}
              />
            ))}
          </ul>
        )}
      </Card>

      <div className="grid shrink-0 grid-cols-1 gap-3 @[720px]:min-h-[280px] @[720px]:flex-1 @[720px]:shrink @[720px]:grid-cols-2">
        <InContext task={task} items={items} receipt={receipt} />
        <Card aria-labelledby="context-history-heading" className="min-h-0 gap-0 px-0 py-3">
          <PanelHead
            id="context-history-heading"
            title="Compactions and fresh sessions"
            count={history.length}
          />
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 scroll-fade">
            {receipt.isPending && history.length === 0 ? (
              <Skeleton className="h-16 w-full rounded-md" />
            ) : history.length === 0 ? (
              <p className="m-0 py-1 text-sm text-fg-faint text-pretty">
                None yet. Every agent is still in its first session.
              </p>
            ) : (
              <ol aria-label="Compactions and fresh sessions" className="m-0 flex list-none flex-col p-0">
                {history.map((event, i) => (
                  <HistoryRow key={`${event.at}-${event.agent}`} event={event} now={now} first={i === 0} />
                ))}
              </ol>
            )}
            <Receipt receipt={receipt} />
          </div>
        </Card>
      </div>
    </section>
  );
}

function PanelHead({ id, title, count }: { id: string; title: string; count?: number }) {
  return (
    <div className="flex shrink-0 items-baseline gap-2 px-4 pb-2">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {count !== undefined && count > 0 && (
        <span className="tnum font-mono text-xs text-fg-faint">{count}</span>
      )}
    </div>
  );
}

const TONE_BAR: Record<MeterTone, string> = { calm: "bg-blue", amber: "bg-amber", red: "bg-red" };
const TONE_TEXT: Record<MeterTone, string> = { calm: "text-fg", amber: "text-amber", red: "text-red" };

/** One agent: the meter with its threshold, what last happened to its session, and the actions. */
function AgentContext({
  task,
  id,
  live,
  compactAt,
  base,
  last,
  now,
}: {
  task: string;
  id: string;
  live: AgentLive | undefined;
  compactAt: number;
  /** The task's own threshold, said once above; an agent's own differing one shows on its row. */
  base: number;
  last: ContextEvent | undefined;
  now: number;
}) {
  const toast = useToast();
  const usage = live?.usage;
  const share = usage === undefined ? undefined : Math.min(1, usage.used / usage.size);
  const tone = share === undefined ? "calm" : meterTone(share, compactAt);
  const canCompact = live?.commands.some((c) => c.name.replace(/^\//, "") === "compact") ?? false;
  const compact = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("room.send", { task, text: "/compact", agent: id, attachments: [], mode: "queue" }),
    onSuccess: () => toast(`Asked @${id} to compact`),
    onError: (e) => toast("Could not compact", { detail: e.message, tone: "error" }),
  });
  const fresh = useMutation<unknown, ApiRequestError>({
    mutationFn: () => cmd("room.fresh", { task, agent: id }, { reason: "Owner pressed Fresh session" }),
    onSuccess: () => toast(`@${id} starts a fresh session`),
    onError: (e) => toast("Could not start a fresh session", { detail: e.message, tone: "error" }),
  });
  const session = last
    ? `${EVENT_WORDS[last.reason].what} ${formatAgo(last.at, now)}`
    : live
      ? "First session"
      : "Not started";
  return (
    <li className="flex flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 last:pb-0.5">
      <div className="flex min-w-0 items-center gap-2">
        <AgentAvatar id={id} size={22} dot={agentDot(live)} />
        <span className="min-w-0 truncate font-mono text-sm font-medium">@{id}</span>
        {live?.model && (
          <span className="hidden shrink-0 font-mono text-xs text-fg-faint @[600px]:inline">
            {live.model}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-baseline gap-1.5">
          {share !== undefined && usage ? (
            <>
              <span className={cn("tnum font-mono text-sm font-medium", TONE_TEXT[tone])}>
                {Math.round(share * 100)}%
              </span>
              <span className="tnum font-mono text-xs text-fg-faint">
                {formatTokens(usage.used)} of {formatTokens(usage.size)}
              </span>
            </>
          ) : (
            <span className="text-xs text-fg-faint">{live ? "No reading yet" : "Not started"}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center">
          {canCompact && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              disabled={compact.isPending}
              title="Send /compact: the agent summarizes its own context"
              aria-label={`Compact @${id}`}
              onClick={() => compact.mutate()}
            >
              Compact
            </Button>
          )}
          {live && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2"
              disabled={fresh.isPending}
              title="Start over in a fresh session that carries a handoff note"
              aria-label={`Fresh session for @${id}`}
              onClick={() => fresh.mutate()}
            >
              Fresh session
            </Button>
          )}
        </span>
      </div>
      <ContextBar
        share={share}
        compactAt={compactAt}
        tone={tone}
        agent={id}
        label={usage && `${formatTokens(usage.used)} of ${formatTokens(usage.size)} tokens`}
      />
      <span className="flex min-w-0 gap-1.5 text-xs text-fg-faint">
        <span className="min-w-0 truncate" title={last ? EVENT_WORDS[last.reason].why : undefined}>
          {session}
          {last && last.before !== undefined && last.after !== undefined && (
            <span className="tnum font-mono">
              {" "}
              ({formatTokens(last.before)} to {formatTokens(last.after)})
            </span>
          )}
        </span>
        {live?.turns !== undefined && live.turns > 0 && (
          <span className="tnum shrink-0">· {plural(live.turns, "turn")} this session</span>
        )}
        {compactAt !== base && (
          <span className="ml-auto shrink-0">Compacts at {Math.round(compactAt * 100)}%</span>
        )}
      </span>
    </li>
  );
}

/** The meter: how full the window is, with a tick where majhi compacts. */
function ContextBar({
  share,
  compactAt,
  tone,
  agent,
  label,
}: {
  share: number | undefined;
  compactAt: number;
  tone: MeterTone;
  agent: string;
  label: string | undefined;
}) {
  const percent = share === undefined ? 0 : Math.round(share * 100);
  return (
    <span className="relative block h-1.5">
      {share !== undefined && (
        <meter
          className="sr-only"
          aria-label={`Context of @${agent}`}
          aria-valuetext={label}
          min={0}
          max={100}
          value={percent}
        />
      )}
      <span aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-full bg-line-strong">
        <span
          className={cn("block h-full rounded-full transition-[width] duration-500", TONE_BAR[tone])}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span
        aria-hidden="true"
        title={`Compacts at ${Math.round(compactAt * 100)}%`}
        style={{ left: `${compactAt * 100}%` }}
        className="absolute -top-1 -bottom-1 w-px bg-fg-muted"
      />
    </span>
  );
}

/** What the team's context holds: the brief, memory, the files it read, the room, attachments and skills. */
function InContext({
  task,
  items,
  receipt,
}: {
  task: Task;
  items: readonly RoomItem[];
  receipt: ReceiptQuery;
}) {
  const [allFiles, setAllFiles] = useState(false);
  const files = filesRead(items, task.folder);
  const shownFiles = allFiles ? files : files.slice(0, FILES_SHOWN);
  const context = receipt.data?.context;
  const skills = useSkillRuns(task.id).data ?? [];
  const messages = roomMessages(items);
  return (
    <Card aria-labelledby="context-holds-heading" className="min-h-0 gap-0 px-0 py-3">
      <PanelHead id="context-holds-heading" title="In the context" />
      <dl className="m-0 flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 scroll-fade">
        <BriefFile task={task} tokens={context?.briefTokens ?? null} />
        <Row label="Memory">
          {context === undefined ? (
            <span className="text-fg-faint">{receipt.isError ? "Not known" : "Loading"}</span>
          ) : context.memoryTokens === 0 && context.recalls === 0 ? (
            <span className="text-fg-muted">None recalled</span>
          ) : (
            <span>
              {context.memoryTokens > 0
                ? `~${formatTokens(context.memoryTokens)} tokens in the brief`
                : "None in the brief"}
              {context.recalls > 0 && (
                <span className="text-fg-muted">
                  {" "}
                  · {plural(context.recalls, "recall")}, ~{formatTokens(context.recallTokens)} tokens
                </span>
              )}
            </span>
          )}
        </Row>
        <Row label="Files read">
          {files.length === 0 ? (
            <span className="text-fg-muted">None this session</span>
          ) : (
            <span className="flex min-w-0 flex-col gap-0.5">
              <ul aria-label="Files read this session" className="m-0 flex list-none flex-col p-0">
                {shownFiles.map((f) => (
                  <li key={f.label} className="flex min-w-0 items-baseline gap-2">
                    {f.path ? (
                      <ViewerLink
                        path={f.path}
                        title={`Open ${f.label}`}
                        className="min-w-0 truncate font-mono text-xs text-blue hover:underline"
                      >
                        {f.label}
                      </ViewerLink>
                    ) : (
                      <span className="min-w-0 truncate font-mono text-xs" title={f.label}>
                        {f.label}
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono text-xs text-fg-faint">@{f.agent}</span>
                  </li>
                ))}
              </ul>
              {files.length > FILES_SHOWN && (
                <button
                  type="button"
                  onClick={() => setAllFiles((v) => !v)}
                  className="cursor-pointer self-start text-xs text-fg-muted hover:text-fg"
                >
                  {allFiles ? "Show fewer" : `Show all ${files.length}`}
                </button>
              )}
            </span>
          )}
        </Row>
        <Row label="Room">
          <span className="text-fg-muted">
            {messages === 0
              ? "No messages yet"
              : `${plural(messages, "message")}. A fresh session gets a summary of the last 40.`}
          </span>
        </Row>
        <Row label="Attachments">
          {task.attachments.length === 0 ? (
            <span className="text-fg-muted">None</span>
          ) : (
            <ul aria-label="Attachments given to the team" className="m-0 flex list-none flex-col p-0">
              {task.attachments.map((a) => (
                <li key={a.id} className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate">{a.url ?? a.name}</span>
                  <span className="shrink-0 text-xs text-fg-faint">{attachmentUse(a)}</span>
                </li>
              ))}
            </ul>
          )}
        </Row>
        <Row label="Skills">
          {skills.every((run) => run.had.length === 0) ? (
            <span className="text-fg-muted">None. A skill loads only its name until an agent uses it.</span>
          ) : (
            <ul aria-label="Skills each run had" className="m-0 flex list-none flex-col gap-1 p-0">
              {skills.map((run) => (
                <RunSkills key={run.agent} run={run} single={skills.length === 1} />
              ))}
            </ul>
          )}
        </Row>
      </dl>
    </Card>
  );
}

/** What one agent's run used, named, and how many it had, which opens to the names. */
function RunSkills({ run, single }: { run: SkillRun; single: boolean }) {
  const [open, setOpen] = useState(false);
  if (run.had.length === 0) return null;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="min-w-0">
        {!single && <span className="text-fg-muted">{`@${run.agent}: `}</span>}
        <span className="text-fg-muted">Used: </span>
        {run.used.length === 0 ? (
          <span className="text-fg">none</span>
        ) : (
          run.used.map((name, i) => (
            <span key={name}>
              {i > 0 && ", "}
              <Link to={PAGE_PATH.skills} search={{ skill: name }} className="text-fg hover:underline">
                {name}
              </Link>
            </span>
          ))
        )}
      </span>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex cursor-pointer items-center gap-1 self-start text-left text-fg-muted hover:text-fg"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn("size-3 shrink-0 text-fg-faint", open && "rotate-90")}
        />
        {`${run.had.length} available`}
      </button>
      {open && (
        <ul
          aria-label={`Skills of @${run.agent}`}
          className="m-0 ml-4 flex list-none flex-wrap gap-x-3 gap-y-0.5 p-0"
        >
          {run.had.map((name) => (
            <li key={name} className="flex items-baseline gap-1">
              <Link to={PAGE_PATH.skills} search={{ skill: name }} className="hover:underline">
                {name}
              </Link>
              {run.used.includes(name) && <span className="text-xs text-fg-faint">used</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Opens a file of the task folder in the viewer over the task. */
function ViewerLink({
  path,
  title,
  className,
  children,
}: {
  path: string;
  title?: string;
  className: string;
  children: ReactNode;
}) {
  return (
    <Link to="." search={(prev: object) => ({ ...prev, file: path })} title={title} className={className}>
      {children}
    </Link>
  );
}

function Row({ label, children, below }: { label: string; children: ReactNode; below?: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-line py-2 text-sm first:border-t-0 first:pt-0">
      <dt className="text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
      {below && <dd className="col-span-2 m-0 min-w-0">{below}</dd>}
    </div>
  );
}

/** TASK.md, the brief every session starts from: its size, and the file itself behind Show. */
function BriefFile({ task, tokens }: { task: Task; tokens: number | null }) {
  const [open, setOpen] = useState(false);
  const text = useFileText(task.id, { kind: "task", path: "TASK.md" }, task.updatedAt, open);
  return (
    <Row
      label="Brief"
      below={
        open && (
          <div className="max-h-[50dvh] overflow-y-auto overscroll-contain rounded-md border border-line bg-sunken px-3 py-2 scroll-fade">
            {text.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : text.isError ? (
              <p className="m-0 text-sm text-red">{describeError(text.error)}</p>
            ) : (
              <Markdown
                text={text.data?.text ?? ""}
                task={{ id: task.id, folder: task.folder, project: task.repos[0]?.project }}
              />
            )}
          </div>
        )
      }
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs">TASK.md</span>
          <span className="text-fg-muted">
            {tokens === null ? "Not sent yet" : `~${formatTokens(tokens)} tokens when first sent`}
          </span>
        </span>
        <span className="flex items-center gap-3">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="flex cursor-pointer items-center gap-0.5 rounded-sm text-xs text-fg-muted hover:text-fg"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn("size-3 transition-transform", open && "rotate-90")}
            />
            {open ? "Hide TASK.md" : "Show TASK.md"}
          </button>
          <ViewerLink path="TASK.md" className="flex items-center gap-1 text-xs text-blue hover:underline">
            <FileText aria-hidden="true" className="size-3" />
            Open in viewer
          </ViewerLink>
        </span>
      </span>
    </Row>
  );
}

function HistoryRow({ event, now, first }: { event: ContextEvent; now: number; first: boolean }) {
  const words = EVENT_WORDS[event.reason];
  return (
    <li className={cn("flex flex-col gap-0.5 py-2", first ? "pt-0" : "border-t border-line")}>
      <span className="flex min-w-0 items-baseline gap-2 text-sm">
        <span className="shrink-0 font-medium">{words.what}</span>
        <span className="min-w-0 truncate font-mono text-xs text-fg-muted">@{event.agent}</span>
        <span className="ml-auto shrink-0 text-xs text-fg-faint" title={new Date(event.at).toLocaleString()}>
          {formatAgo(event.at, now)}
        </span>
      </span>
      <span className="flex min-w-0 items-baseline gap-2 text-xs text-fg-faint">
        <span className="min-w-0 text-pretty">{words.why}</span>
        {(event.before !== undefined || event.after !== undefined) && (
          <span className="tnum ml-auto shrink-0 font-mono">
            {event.before === undefined ? "?" : formatTokens(event.before)} to{" "}
            {event.after === undefined ? "?" : formatTokens(event.after)}
          </span>
        )}
        {event.note && (
          <ViewerLink
            path={event.note}
            className="shrink-0 text-blue hover:underline"
            title={`Open the handoff note ${event.note}`}
          >
            Note
          </ViewerLink>
        )}
      </span>
    </li>
  );
}

/** One line of what the task cost, and the full receipt behind Show. */
function Receipt({ receipt }: { receipt: ReceiptQuery }) {
  const [open, setOpen] = useState(false);
  const data = receipt.data;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
        <span className="font-medium">Tokens and cost</span>
        {data && (
          <span className="tnum text-fg-muted">
            <span className="font-mono">{formatTokens(data.totals.totalTokens)}</span> tokens ·{" "}
            <CostText totals={data.totals} /> · cache hit {hitRateText(data.cacheHitRate)}
          </span>
        )}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="ml-auto flex cursor-pointer items-center gap-0.5 text-xs text-fg-muted hover:text-fg"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3 transition-transform", open && "rotate-90")}
          />
          {open ? "Hide receipt" : "Show receipt"}
        </button>
      </span>
      {receipt.isError && <p className="m-0 text-sm text-red">{describeError(receipt.error)}</p>}
      {open && data && <TaskReceiptView receipt={data} />}
    </div>
  );
}
