import type { AutonomySettings, AutonomySummary } from "@majhi/shared";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageLink } from "@/components/ui/page-link";
import { SectionLabel } from "@/components/ui/section-label";
import { capText, capTone } from "@/features/autonomy/model";
import { TaskRef } from "@/features/autonomy/task-ref";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
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

/** Shipped work by workspace: the saved groups, or built from the list for a summary made before groups. */
function shipGroups(summary: AutonomySummary): AutonomySummary["shipGroups"] {
  if (summary.shipGroups.length > 0 || summary.shipped.length === 0) return summary.shipGroups;
  const by = new Map<string, { count: number; titles: string[] }>();
  for (const s of summary.shipped) {
    const g = by.get(s.org ?? "private") ?? { count: 0, titles: [] };
    g.count++;
    if (g.titles.length < 3) g.titles.push(s.title);
    by.set(s.org ?? "private", g);
  }
  return [...by].map(([org, g]) => ({ org, name: org === "private" ? "Private" : org, ...g }));
}

/** A label in a narrow column and what it says beside it, so the sheet stays short. */
function Row({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 border-t border-line pt-3 first:border-t-0 first:pt-0"
    >
      <span className="flex flex-col gap-0.5 pt-px">
        <SectionLabel>{label}</SectionLabel>
        {aside}
      </span>
      <div className="flex min-w-0 flex-col gap-1">{children}</div>
    </section>
  );
}

const NOTES_SHOWN = 3;

/**
 * One day, short: what shipped by workspace, what was spent against each budget, what waits on the
 * owner, what the captain plans next, and what it was unsure about. Lives in a sheet.
 */
export function SummaryView({ summary }: { summary: AutonomySummary }) {
  const [allNotes, setAllNotes] = useState(false);
  const groups = shipGroups(summary);
  const notes = allNotes ? summary.unsure : summary.unsure.slice(0, NOTES_SHOWN);
  const hiddenNotes = summary.unsure.length - NOTES_SHOWN;
  const waits = summary.needs?.count ?? summary.waiting.length;
  const shownWaits = summary.needs?.top.length ?? 0;
  const spenders = summary.spent.orgs.filter((o) => o.cap !== undefined || o.used.cost > 0);
  return (
    <div className="flex flex-col gap-3">
      <Row
        label="Shipped"
        aside={<span className="tnum text-sm text-fg-soft">{summary.shipped.length}</span>}
      >
        {groups.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing shipped.</p>
        ) : (
          groups.map((g) => (
            <p key={g.org} className="flex min-w-0 gap-2 text-sm text-fg-soft">
              <span className="shrink-0 font-medium text-fg">
                {g.name} <span className="tnum text-fg-muted">{g.count}</span>
              </span>
              <span className="min-w-0 truncate text-fg-muted" title={g.titles.join(", ")}>
                {g.titles.join(", ")}
                {g.count > g.titles.length ? ` +${g.count - g.titles.length} more` : ""}
              </span>
            </p>
          ))
        )}
        {summary.upkeep > 0 && (
          <p className="text-sm text-fg-muted">Upkeep: {plural(summary.upkeep, "action")}.</p>
        )}
      </Row>
      <Row label="Spent">
        <p
          className={cn("tnum text-sm", capTone(summary.spent.total) === "red" ? "text-red" : "text-fg-soft")}
        >
          {capText(summary.spent.total)}
          {summary.spent.total.cap !== undefined && summary.spent.total.percent > 100 && " (over)"}
        </p>
        {spenders.map((o) => (
          <p key={o.org} className="tnum flex gap-2 text-sm text-fg-muted">
            <span className="min-w-0 truncate">{o.name ?? o.org}</span>
            <span className={cn("ml-auto shrink-0", o.cap !== undefined && o.percent > 100 && "text-red")}>
              {capText(o)}
              {o.cap !== undefined && o.percent > 100 && " (over)"}
            </span>
          </p>
        ))}
      </Row>
      <Row
        label="Needs you"
        aside={waits > 0 ? <span className="tnum text-sm text-amber">{waits}</span> : undefined}
      >
        {waits === 0 ? (
          <p className="text-sm text-fg-faint">Nothing waited for you.</p>
        ) : (
          <>
            {(summary.needs?.top ?? []).map((d) => (
              <p key={d.id} className="min-w-0 truncate text-sm text-fg-soft" title={d.title}>
                {d.title}
              </p>
            ))}
            <PageLink page="decisions" className="w-fit text-sm text-blue hover:underline">
              {waits > shownWaits ? `All ${waits} in Decisions` : "Open Decisions"}
            </PageLink>
          </>
        )}
      </Row>
      <Row label="Next">
        {summary.next.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing planned.</p>
        ) : (
          summary.next.map((n) => (
            <p key={`${n.task ?? ""}${n.title}`} className="flex min-w-0 gap-2 text-sm text-fg-soft">
              {n.task && <TaskRef task={n.task} className="mt-px" />}
              <span className="min-w-0 truncate" title={`${n.title}. ${n.why}`}>
                {n.title}
                <span className="text-fg-muted"> · {n.why}</span>
              </span>
            </p>
          ))
        )}
      </Row>
      <Row label="Notes" aside={<span className="tnum text-sm text-fg-soft">{summary.unsure.length}</span>}>
        {summary.unsure.length === 0 ? (
          <p className="text-sm text-fg-faint">Nothing it was unsure about.</p>
        ) : (
          <>
            {notes.map((u) => (
              <p
                key={`${u.task ?? ""}${u.item ?? ""}${u.text}`}
                className="flex min-w-0 gap-2 text-sm text-fg-soft"
              >
                {u.task && <TaskRef task={u.task} item={u.item} className="mt-px" />}
                <span className={cn("min-w-0", allNotes ? "text-pretty" : "truncate")} title={u.text}>
                  {u.text}
                </span>
              </p>
            ))}
            {hiddenNotes > 0 && (
              <button
                type="button"
                aria-expanded={allNotes}
                onClick={() => setAllNotes(!allNotes)}
                className="w-fit cursor-pointer text-sm text-blue hover:underline"
              >
                {allNotes ? "Show fewer" : `+${hiddenNotes} more`}
              </button>
            )}
          </>
        )}
      </Row>
    </div>
  );
}

/** The summary's time of day, changed here instead of on the Limits screen. */
export function SummaryTime({ settings }: { settings: AutonomySettings }) {
  const id = useId();
  const [draft, setDraft] = useState<string>();
  const save = useAutonomyCommand("autonomy.configure");
  const value = draft ?? settings.summary_at;
  const valid = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
  const dirty = draft !== undefined && draft !== settings.summary_at;
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <label htmlFor={id} className="min-w-0 flex-1 text-fg-muted">
        Made every day at
      </label>
      <Input
        id={id}
        type="time"
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        className="h-8 w-[124px] px-2"
      />
      {dirty && (
        <Button
          size="sm"
          variant="primary"
          disabled={!valid || save.isPending}
          onClick={() =>
            save.mutate(
              { input: { summary_at: value }, reason: "Owner changed the daily summary time" },
              { onSuccess: () => setDraft(undefined) },
            )
          }
        >
          {save.isPending ? "Saving" : "Save"}
        </Button>
      )}
    </div>
  );
}
