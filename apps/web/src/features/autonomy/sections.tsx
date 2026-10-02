import type { AutonomySummary } from "@majhi/shared";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { plural } from "@/lib/format";
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
      <div className="grid gap-4 xl:grid-cols-3">
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
