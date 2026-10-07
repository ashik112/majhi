import { Lamp, type LampState } from "@/components/ui/lamp";
import { cn } from "@/lib/cn";
import type { EntryContext } from "./entry-context";
import { rowDomId } from "./entry-context";
import { type Entry, focusable, type RowEntry, SECTION_LABEL, type SectionId } from "./home-model";
import { TaskCard } from "./task-card";

const HEAD_LAMP: Record<SectionId, LampState> = {
  needs: "needs",
  running: "working",
  waiting: "paused",
  shipping: "done",
  next: "idle",
  triage: "idle",
  captain: "done",
  done: "done",
};

interface Column {
  section: SectionId;
  count: number;
  entries: Entry[];
}

/** The entries of the board cut into its columns: each head starts one. */
function columnsOf(entries: readonly Entry[]): Column[] {
  const out: Column[] = [];
  for (const entry of entries) {
    if (entry.type === "header") out.push({ section: entry.section, count: entry.count, entries: [] });
    else out.at(-1)?.entries.push(entry);
  }
  return out;
}

/** A column with nothing in it folds to a narrow dashed rail with its name set upright. */
function Rail({ section, count }: { section: SectionId; count: number }) {
  return (
    <section
      aria-label={SECTION_LABEL[section]}
      className="flex w-11 min-w-11 flex-none flex-col items-center gap-3 rounded-2xl border border-dashed border-line-control py-3.5"
    >
      <Lamp state={HEAD_LAMP[section]} size={8} />
      <h2 className="text-base font-semibold text-fg-muted [writing-mode:vertical-rl]">
        {SECTION_LABEL[section]}
      </h2>
      <span className="tnum font-mono text-sm text-fg-faint">{count}</span>
    </section>
  );
}

function ColumnView({
  column,
  focusKey,
  selected,
  ctx,
}: {
  column: Column;
  focusKey: string | undefined;
  selected: ReadonlySet<string>;
  ctx: EntryContext;
}) {
  const { section } = column;
  let place = 0;
  return (
    <section
      aria-label={SECTION_LABEL[section]}
      className="flex min-h-0 min-w-[222px] flex-1 basis-0 flex-col overflow-hidden rounded-2xl border border-glass-line bg-glass shadow-glass backdrop-blur-[18px] backdrop-saturate-[1.35] max-[1300px]:min-w-[244px]"
    >
      <div className="relative flex shrink-0 items-center gap-2 px-3 pt-[11px] pb-[9px] after:absolute after:right-0 after:bottom-0 after:left-3 after:h-px after:bg-linear-to-r after:from-hair after:to-transparent after:content-['']">
        <Lamp state={HEAD_LAMP[section]} size={8} />
        <h2 className="text-base font-semibold whitespace-nowrap text-fg">{SECTION_LABEL[section]}</h2>
        <span
          className={cn(
            "tnum font-mono text-sm",
            section === "needs" && column.count > 0 ? "text-lamp-needs" : "text-fg-faint",
          )}
        >
          {column.count}
        </span>
      </div>
      <div className="scroll-fade flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-[9px] pt-[9px] pb-[22px]">
        {column.entries.map((entry) => {
          if (entry.type === "more") {
            return (
              <button
                key={entry.key}
                type="button"
                id={rowDomId(entry.key)}
                onClick={() => {
                  ctx.handlers.onFocus(entry.key);
                  ctx.handlers.onMore(entry.section);
                }}
                className={cn(
                  "grid h-[30px] w-full shrink-0 cursor-pointer place-items-center rounded-lg border border-dashed border-line-control text-sm text-fg-muted hover:border-line-hover hover:text-fg",
                  focusKey === entry.key && "outline-2 outline-accent -outline-offset-1",
                )}
              >
                +{entry.hidden} more
              </button>
            );
          }
          if (entry.type === "header") return null;
          const row: RowEntry = entry;
          if (section === "next") place += 1;
          return (
            <TaskCard
              key={row.key}
              entry={row}
              focused={row.key === focusKey}
              selected={selected.has(row.key)}
              ctx={ctx}
              place={section === "next" ? place : undefined}
            />
          );
        })}
      </div>
    </section>
  );
}

/**
 * The board: a column for each of Needs you, Running, Waiting, Shipping and Up next, and Ideas, Done and
 * the captain's log while they are on. The columns scroll on their own, and the board scrolls sideways
 * inside itself when they do not fit, so the page never scrolls.
 */
export function BoardColumns({
  entries,
  focusKey,
  selected,
  ctx,
}: {
  entries: readonly Entry[];
  focusKey: string | undefined;
  selected: ReadonlySet<string>;
  ctx: EntryContext;
}) {
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden overscroll-contain pt-3 [scrollbar-color:var(--c-line-bright)_transparent] [scrollbar-width:thin]">
      {columnsOf(entries).map((column) =>
        column.entries.filter(focusable).length === 0 ? (
          <Rail key={column.section} section={column.section} count={column.count} />
        ) : (
          <ColumnView
            key={column.section}
            column={column}
            focusKey={focusKey}
            selected={selected}
            ctx={ctx}
          />
        ),
      )}
    </div>
  );
}
