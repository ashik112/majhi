import type { AutonomyStatus, AutonomyWaiting, TaskSize } from "@majhi/shared";
import { Ban } from "lucide-react";
import type { ReactNode } from "react";
import { AgentEmoji } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Lamp } from "@/components/ui/lamp";
import { ROW_SELECTED } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/components/ui/toast";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, formatMoney, plural } from "@/lib/format";
import { GLASS } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";
import { clockTime, SIZE_WORD } from "./model";
import { TaskRef } from "./task-ref";

/** A section of a panel: its title, a count in mono, and a note or action at the right. */
export function SectionHead({
  title,
  count,
  children,
  className,
}: {
  title: string;
  count?: number | undefined;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-7 items-center gap-2", className)}>
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {count !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{count}</span>}
      {children && <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A glass panel as tall as the page whose body scrolls inside it. */
export function Pane({
  label,
  head,
  children,
  className,
}: {
  label: string;
  head?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section
      aria-label={label}
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl", GLASS, className)}
    >
      {head && <div className="shrink-0 border-b border-line px-4 py-2.5">{head}</div>}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain px-4 pt-3 pb-6 scroll-fade">
        {children}
      </div>
    </section>
  );
}

export function SizeBadge({ size, note }: { size: TaskSize | undefined; note?: string | undefined }) {
  if (size === undefined)
    return (
      <span title={note} className="shrink-0 text-xs text-fg-faint">
        size ?
      </span>
    );
  return (
    <Badge tone={size === "large" ? "amber" : "neutral"} title={note}>
      {SIZE_WORD[size]}
    </Badge>
  );
}

/** Marks a task Not for autonomous mode, or clears the mark, with a toast either way. */
export function useExclude() {
  const toast = useToast();
  const exclude = useAutonomyCommand("autonomy.exclude");
  return {
    busy: exclude.isPending,
    set: (task: string, on: boolean) =>
      exclude.mutate(
        {
          input: { task, exclude: on },
          reason: on
            ? `Owner marked ${task} Not for autonomous mode`
            : `Owner let autonomous mode take ${task}`,
        },
        {
          onSuccess: () =>
            on
              ? toast(`${task} is left alone`, {
                  detail: "The captain will not start, message or change it.",
                })
              : toast(`Autonomous mode may take ${task} again`),
          onError: (error) => toast("Could not change it", { detail: describeError(error), tone: "error" }),
        },
      ),
  };
}

const WAITING_WORD: Record<string, string> = {
  approval: "Approval",
  permission: "Permission",
  "secret-request": "Secret",
  ask: "Question",
  choice: "Choice",
  "owner-question": "Question",
  review: "Review",
};

function WaitingSection({ waiting }: { waiting: readonly AutonomyWaiting[] }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-lamp-needs/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-needs)_7%,transparent),transparent_70%)] px-3 py-2.5">
      <SectionHead title="Waiting for you" count={waiting.length}>
        <span className="flex items-center gap-1.5 text-sm text-lamp-needs">
          <Lamp state="needs" size={7} />
          Needs you
        </span>
      </SectionHead>
      <ul className="flex flex-col">
        {waiting.map((w) => (
          <li
            key={`${w.task}:${w.item}`}
            className="flex min-w-0 flex-col gap-0.5 border-t border-line py-1.5 first:border-t-0"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Badge tone="amber">{WAITING_WORD[w.kind] ?? w.kind}</Badge>
              <TaskRef task={w.task} item={w.item} />
              <span className="min-w-0 truncate text-base text-fg" title={w.text}>
                {w.text}
              </span>
            </span>
            <span className="text-sm text-fg-muted text-pretty">Left for you: {w.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const IDLE_LINE: Record<AutonomyStatus["mode"], string> = {
  on: "Idle until majhi wakes it",
  paused: "Gets no wake-ups until you resume",
  stopping: "Picks nothing new while it stops",
  off: "Works only when you ask it to",
};

function NowSection({ status, now }: { status: AutonomyStatus; now: number }) {
  const boss = status.boss;
  return (
    <div className="flex flex-col gap-1.5">
      <SectionHead title="Now" count={status.now.length}>
        {status.lastTick && (
          <span className="text-sm text-fg-faint">captain woken {formatAgo(status.lastTick, now)}</span>
        )}
      </SectionHead>
      {boss ? (
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <Lamp state={boss.working ? "working" : "idle"} size={7} />
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-fg-muted">
            <AgentEmoji id={boss.id} />@{boss.id}
          </span>
          <span className={cn("min-w-0 truncate", boss.working ? "text-fg-soft" : "text-fg-faint")}>
            {boss.nowDoing ?? (boss.working ? "Working" : IDLE_LINE[status.mode])}
          </span>
        </p>
      ) : (
        <p className="text-sm text-amber">There is no captain. Pick one on Agents to use autonomous mode.</p>
      )}
      {status.holds.map((h) => (
        <p key={`${h.kind}:${h.id ?? ""}`} className="text-sm text-amber text-pretty">
          Held: {h.text}
          {h.until && <span className="text-fg-faint"> Until {clockTime(h.until, now)}.</span>}
        </p>
      ))}
      {status.now.length === 0 ? (
        <p className="text-sm text-fg-faint">No autonomous task is open.</p>
      ) : (
        <ul className="flex flex-col">
          {status.now.map((t) => (
            <li key={t.task} className="flex min-w-0 flex-col gap-0.5 border-t border-line py-2">
              <span className="flex min-w-0 items-center gap-2">
                <StatusBadge status={t.status} />
                <TaskRef task={t.task} />
                <span className="min-w-0 truncate text-base text-fg" title={t.title}>
                  {t.title}
                </span>
              </span>
              {t.agents
                .filter((a) => a.nowDoing !== undefined)
                .map((a) => (
                  <span key={a.id} className="flex min-w-0 gap-2 text-sm">
                    <span className="flex shrink-0 items-center gap-1.5 font-mono text-fg-muted">
                      <AgentEmoji id={a.id} />@{a.id}
                    </span>
                    <span className="min-w-0 truncate text-fg-soft">{a.nowDoing}</span>
                  </span>
                ))}
              {t.why && <span className="text-sm text-fg-muted text-pretty">Why: {t.why}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NextSection({ status, now, onRules }: { status: AutonomyStatus; now: number; onRules: () => void }) {
  const orgs = useOrgs().data ?? [];
  const exclude = useExclude();
  const name = (id: string) => orgs.find((o) => o.id === id)?.name ?? id;
  const backlog = new Map(status.backlog.map((b) => [b.task, b]));
  const leftOut = status.backlog.filter((b) => b.leftOut !== undefined).length;
  return (
    <div className="flex flex-col gap-1.5">
      <SectionHead title="Next" count={status.queue.length}>
        {status.queuedAt && (
          <span className="text-sm text-fg-faint">planned {formatAgo(status.queuedAt, now)}</span>
        )}
      </SectionHead>
      {status.queue.length === 0 ? (
        <p className="text-sm text-fg-faint">
          Nothing planned yet. The captain sets this list after each wake-up, each item with why.
        </p>
      ) : (
        <ol className="flex flex-col">
          {status.queue.map((q, i) => {
            const item = q.task === undefined ? undefined : backlog.get(q.task);
            return (
              <li
                key={`${q.task ?? ""}|${q.title}|${q.why}`}
                className="group flex min-w-0 gap-2.5 border-t border-line py-2 first:border-t-0"
              >
                <span className="tnum w-4 shrink-0 pt-px text-right font-mono text-sm text-fg-faint">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex min-w-0 items-center gap-2">
                    {q.task && <TaskRef task={q.task} />}
                    <span className="min-w-0 truncate text-base text-fg" title={q.title}>
                      {q.title}
                    </span>
                    {item && <SizeBadge size={item.size} note={item.sizeNote} />}
                    {q.task === undefined && q.org && (
                      <span className="shrink-0 text-xs text-fg-faint">{name(q.org)}</span>
                    )}
                  </span>
                  <span className="text-sm text-fg-muted text-pretty">
                    {q.after && Date.parse(q.after) > now && (
                      <span className="text-fg-faint">Not before {clockTime(q.after, now)}. </span>
                    )}
                    Why: {q.why}
                  </span>
                </span>
                {q.task && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Leave ${q.task} alone`}
                    title="Not for autonomous mode: the captain leaves this task alone"
                    disabled={exclude.busy || item?.noAutonomy === true}
                    onClick={() => q.task && exclude.set(q.task, true)}
                    className="shrink-0 opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    <Ban aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="text-sm text-fg-faint">
        The captain picks from {plural(status.backlog.length - leftOut, "backlog task")}
        {leftOut > 0 && `; the rules leave out ${leftOut}`}.{" "}
        <button type="button" onClick={onRules} className="cursor-pointer text-blue hover:underline">
          Rules
        </button>
      </p>
    </div>
  );
}

/**
 * One row per workspace where the captain starts work (5.18): the captain's lane there, what it does now or why it
 * rests, its open tasks and today's spend against the workspace's budget. A row shows its lane's chat.
 */
function LanesSection({
  status,
  lane,
  onLane,
}: {
  status: AutonomyStatus;
  lane: string | undefined;
  onLane: (org: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionHead title="Lanes" count={status.lanes.length}>
        <PageLink page="captain" className="text-sm text-blue hover:underline">
          Captain page
        </PageLink>
      </SectionHead>
      {status.lanes.length === 0 ? (
        <p className="text-sm text-amber text-pretty">
          In no workspace does the captain decide when work starts, so it starts nothing. Change that on the
          Captain page.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {status.lanes.map((l) => {
            const on = l.org === lane;
            const cost = l.spend.cap?.cost;
            return (
              <li key={l.org}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onLane(l.org)}
                  title={`Show the captain's lane in ${l.name}`}
                  className={cn(
                    "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors duration-150",
                    on ? ROW_SELECTED : "hover:bg-raised",
                  )}
                >
                  <Lamp state={l.working ? "working" : l.resting ? "paused" : "idle"} size={7} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-base font-medium text-fg">{l.name}</span>
                      <span className="tnum shrink-0 text-xs text-fg-faint">{plural(l.tasks, "task")}</span>
                    </span>
                    <span
                      className={cn("min-w-0 truncate text-sm", l.resting ? "text-amber" : "text-fg-muted")}
                      title={l.resting ?? l.nowDoing}
                    >
                      {l.resting
                        ? `Resting: ${l.resting}`
                        : (l.nowDoing ??
                          (l.working ? "Working" : `Idle. ${plural(l.backlog, "backlog task")} it may take`))}
                    </span>
                  </span>
                  <span className="tnum shrink-0 font-mono text-sm text-fg-soft">
                    {formatMoney(l.spend.used.cost)}
                    <span className="font-sans text-fg-faint">
                      {cost === undefined ? "" : ` of ${formatMoney(cost)}`}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What needs the owner, which lanes run, what runs and what comes next, with why for each. */
export function WorkPane({
  status,
  now,
  onRules,
  lane,
  onLane,
  className,
}: {
  status: AutonomyStatus;
  now: number;
  onRules: () => void;
  lane: string | undefined;
  onLane: (org: string) => void;
  className?: string;
}) {
  return (
    <Pane label="Now and next" className={className}>
      {status.waiting.length > 0 && <WaitingSection waiting={status.waiting} />}
      <LanesSection status={status} lane={lane} onLane={onLane} />
      <NowSection status={status} now={now} />
      <NextSection status={status} now={now} onRules={onRules} />
    </Pane>
  );
}
