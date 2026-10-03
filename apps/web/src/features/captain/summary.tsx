import type { AutonomySummary } from "@majhi/shared";
import { Badge } from "@/components/ui/badge";
import { SectionLabel } from "@/components/ui/section-label";
import { capText, capTone, HOW_WORD } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { cn } from "@/lib/cn";
import { formatMoney, plural } from "@/lib/format";

/** "Thu 1 Oct" for a `YYYY-MM-DD` day. */
export function dayLabel(day: string): string {
  const at = new Date(`${day}T12:00:00`);
  return Number.isNaN(at.getTime())
    ? day
    : at.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** The day before `now`, `YYYY-MM-DD` on the local calendar. */
function yesterday(now: number): string {
  const d = new Date(now - 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The chip's one line: "Yesterday: shipped 30, spent $80.56 of $50 (over), 9 notes". */
export function summaryLine(summary: AutonomySummary, now: number): { text: string; over: boolean } {
  const total = summary.spent.total;
  const over = capTone(total) === "red";
  const cap = total.cap?.cost;
  const spent =
    cap === undefined
      ? formatMoney(total.used.cost)
      : `${formatMoney(total.used.cost)} of ${Number.isInteger(cap) ? `$${cap}` : formatMoney(cap)}${over ? " (over)" : ""}`;
  const when = summary.day === yesterday(now) ? "Yesterday" : dayLabel(summary.day);
  const notes = summary.unsure.length;
  return {
    text: `${when}: shipped ${summary.shipped.length}, spent ${spent}${notes > 0 ? `, ${plural(notes, "note")}` : ""}`,
    over,
  };
}

/** What it shipped, what it spent and what it was unsure about, for one day. Lives in a sheet. */
export function SummaryView({ summary }: { summary: AutonomySummary }) {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-1.5">
        <SectionLabel>Spent</SectionLabel>
        <p
          className={cn("tnum text-sm", capTone(summary.spent.total) === "red" ? "text-red" : "text-fg-soft")}
        >
          {capText(summary.spent.total)}
        </p>
        {summary.spent.orgs.map((o) => (
          <p key={o.org} className="tnum flex gap-2 text-sm text-fg-muted">
            <span className="min-w-0 truncate">{o.org}</span>
            <span className="ml-auto shrink-0">{capText(o)}</span>
          </p>
        ))}
      </section>
      <section className="flex flex-col gap-1.5">
        <SectionLabel>Shipped {summary.shipped.length}</SectionLabel>
        {summary.shipped.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing shipped.</p>
        ) : (
          <ul className="flex flex-col">
            {summary.shipped.map((s) => (
              <li
                key={s.task}
                className="flex min-w-0 items-center gap-2 border-t border-line py-1.5 text-sm first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate text-fg-soft" title={s.title}>
                  {s.title}
                </span>
                <TaskRef task={s.task} />
                <Badge tone={s.how === "review" ? "amber" : "green"}>{HOW_WORD[s.how]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-1.5">
        <SectionLabel>Notes {summary.unsure.length}</SectionLabel>
        {summary.unsure.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing it was unsure about.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {summary.unsure.map((u) => (
              <li key={`${u.task ?? ""}${u.item ?? ""}${u.text}`} className="flex gap-2 text-sm text-fg-soft">
                {u.task && <TaskRef task={u.task} item={u.item} className="mt-px" />}
                <span className="min-w-0 text-pretty">{u.text}</span>
              </li>
            ))}
          </ul>
        )}
        {summary.waiting.length > 0 && (
          <p className="text-sm text-amber">{plural(summary.waiting.length, "card")} waited for you.</p>
        )}
      </section>
    </div>
  );
}
