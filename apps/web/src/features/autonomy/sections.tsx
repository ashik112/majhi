import type { AutonomyStatus, AutonomySummary, AutonomyWaiting } from "@majhi/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Lamp } from "@/components/ui/lamp";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusBadge } from "@/components/ui/status-badge";
import { formatAgo, plural } from "@/lib/format";
import { capText, clockTime, HOW_WORD } from "./model";
import { TaskRef } from "./task-ref";

/** A card's heading: its title, a count in mono, and a note or action at the right. */
export function CardHead({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 items-center gap-2">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {count !== undefined && <span className="tnum font-mono text-sm text-fg-faint">{count}</span>}
      {children && <div className="ml-auto flex min-w-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** "Thu 1 Oct" for a `YYYY-MM-DD` day. */
function dayLabel(day: string): string {
  const at = new Date(`${day}T12:00:00`);
  return Number.isNaN(at.getTime())
    ? day
    : at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** What it shipped, what it spent and what it is unsure about, for one day. */
export function SummaryCard({ summary, now }: { summary: AutonomySummary; now: number }) {
  return (
    <Card aria-label="Daily summary">
      <CardHead title="Daily summary">
        <span className="text-sm text-fg-faint">
          {dayLabel(summary.day)}, made {clockTime(summary.at, now)} · {plural(summary.decisions, "decision")}
        </span>
      </CardHead>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <SectionLabel>Shipped</SectionLabel>
          {summary.shipped.length === 0 ? (
            <p className="text-sm text-fg-faint">Nothing shipped.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {summary.shipped.map((s) => (
                <li key={s.task} className="flex min-w-0 items-center gap-2 text-sm">
                  <TaskRef task={s.task} />
                  <span className="min-w-0 truncate text-fg-soft">{s.title}</span>
                  <Badge tone={s.how === "review" ? "amber" : "green"} className="ml-auto">
                    {HOW_WORD[s.how]}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <SectionLabel>Spent</SectionLabel>
          <p className="tnum text-sm text-fg-soft">{capText(summary.spent.total)}</p>
          {summary.spent.orgs.map((o) => (
            <p key={o.org} className="tnum flex gap-2 text-sm text-fg-muted">
              <span className="min-w-0 truncate">{o.org}</span>
              <span className="ml-auto shrink-0">{capText(o)}</span>
            </p>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <SectionLabel>Unsure</SectionLabel>
          {summary.unsure.length === 0 ? (
            <p className="text-sm text-fg-faint">Nothing it was unsure about.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {summary.unsure.map((u) => (
                <li
                  key={`${u.task ?? ""}${u.item ?? ""}${u.text}`}
                  className="flex gap-2 text-sm text-fg-soft"
                >
                  {u.task && <TaskRef task={u.task} item={u.item} className="mt-px" />}
                  <span className="min-w-0 text-pretty">{u.text}</span>
                </li>
              ))}
            </ul>
          )}
          {summary.waiting.length > 0 && (
            <p className="text-sm text-amber">{plural(summary.waiting.length, "card")} waited for you.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The boss's own line, then each autonomous task that is not done and what its agents do. */
export function NowCard({ status, now }: { status: AutonomyStatus; now: number }) {
  const boss = status.boss;
  return (
    <Card aria-label="Now">
      <CardHead title="Now" count={status.now.length}>
        {status.lastTick && (
          <span className="text-sm text-fg-faint">woke {formatAgo(status.lastTick, now)}</span>
        )}
      </CardHead>
      {boss ? (
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <Lamp state={boss.working ? "working" : "idle"} size={7} />
          <span className="shrink-0 font-mono text-fg-muted">@{boss.id}</span>
          <span className={boss.working ? "min-w-0 truncate text-fg-soft" : "min-w-0 truncate text-fg-faint"}>
            {boss.nowDoing ?? (boss.working ? "Working" : "Idle until majhi wakes it")}
          </span>
          {boss.chat && <TaskRef task={boss.chat} className="ml-auto" />}
        </p>
      ) : (
        <p className="text-sm text-amber">There is no boss. Pick one on Agents to use autonomous mode.</p>
      )}
      {status.now.length === 0 ? (
        <p className="text-sm text-fg-faint">No autonomous task is open.</p>
      ) : (
        <ul className="flex flex-col">
          {status.now.map((t) => (
            <li key={t.task} className="flex min-w-0 flex-col gap-1 border-t border-line py-2">
              <span className="flex min-w-0 items-center gap-2">
                <StatusBadge status={t.status} />
                <TaskRef task={t.task} />
                <span className="min-w-0 truncate text-base text-fg">{t.title}</span>
                {t.org && <span className="ml-auto shrink-0 text-xs text-fg-faint">{t.org}</span>}
              </span>
              {t.agents.map((a) => (
                <span key={a.id} className="flex min-w-0 gap-2 pl-1 text-sm">
                  <span className="shrink-0 font-mono text-fg-muted">@{a.id}</span>
                  <span className="min-w-0 truncate text-fg-soft">
                    {a.nowDoing ?? "Waiting for its turn"}
                  </span>
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** What the boss plans next, in order, each with its one line why. */
export function QueueCard({ status, now }: { status: AutonomyStatus; now: number }) {
  return (
    <Card aria-label="Queue">
      <CardHead title="Queue" count={status.queue.length}>
        {status.queuedAt && (
          <span className="text-sm text-fg-faint">planned {formatAgo(status.queuedAt, now)}</span>
        )}
      </CardHead>
      {status.queue.length === 0 ? (
        <p className="text-sm text-fg-faint">
          Nothing planned yet. The boss sets the queue after each wake-up.
        </p>
      ) : (
        <ol className="flex flex-col">
          {status.queue.map((q, i) => (
            <li
              key={`${q.task ?? ""}|${q.title}|${q.why}`}
              className="flex min-w-0 gap-3 border-t border-line py-2 first:border-t-0"
            >
              <span className="tnum w-4 shrink-0 text-right font-mono text-sm text-fg-faint">{i + 1}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-base text-fg">{q.title}</span>
                  {q.task && <TaskRef task={q.task} />}
                  {q.org && <span className="shrink-0 text-xs text-fg-faint">{q.org}</span>}
                  {q.after && Date.parse(q.after) > now && (
                    <span className="ml-auto shrink-0 text-xs text-fg-faint">
                      not before {clockTime(q.after, now)}
                    </span>
                  )}
                </span>
                <span className="text-sm text-fg-muted text-pretty">{q.why}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
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

/** Cards in autonomous tasks only the owner can decide, each with why autonomous mode left it. */
export function WaitingCard({ waiting }: { waiting: readonly AutonomyWaiting[] }) {
  return (
    <Card aria-label="Waiting for you">
      <CardHead title="Waiting for you" count={waiting.length} />
      {waiting.length === 0 ? (
        <p className="text-sm text-fg-faint">Nothing waits for you.</p>
      ) : (
        <ul className="flex flex-col">
          {waiting.map((w) => (
            <li
              key={`${w.task}:${w.item}`}
              className="flex min-w-0 flex-col gap-0.5 border-t border-line py-2 first:border-t-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <Badge tone="amber">{WAITING_WORD[w.kind] ?? w.kind}</Badge>
                <TaskRef task={w.task} item={w.item} />
                <span className="min-w-0 truncate text-base text-fg">{w.text}</span>
              </span>
              <span className="text-sm text-fg-muted text-pretty">Left for you: {w.why}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
