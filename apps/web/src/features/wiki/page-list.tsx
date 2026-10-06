import type { WikiPage, WikiPageId, WikiPageSummary } from "@majhi/shared";
import { ListPane, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { cn } from "@/lib/cn";
import { GROUPS, subline } from "./model";
import { StaleMark } from "./parts";

/** One page of the list as the view knows it: its summary, the page once read, and whether a newer commit touched it. */
export interface ListEntry {
  summary: WikiPageSummary;
  page: WikiPage | undefined;
  stale: boolean;
}

/** The left side: pages by group, each with what it is about; Gaps carries the count of what needs a look. */
export function PageList({
  entries,
  selected,
  openItems,
  onSelect,
}: {
  entries: readonly ListEntry[];
  selected: WikiPageId | undefined;
  /** How many guesses and unconfirmed claims there are across the pages. */
  openItems: number;
  onSelect: (id: WikiPageId) => void;
}) {
  return (
    <ListPane label="Wiki pages">
      <div className="flex flex-col gap-1">
        {GROUPS.map(({ kind, label }) => {
          const rows = entries.filter((e) => e.summary.kind === kind);
          if (rows.length === 0) return null;
          const count = kind === "gaps" ? openItems : rows.length;
          return (
            <section key={kind} aria-label={label} className="flex flex-col gap-px pb-2">
              <h2 className="flex h-8 items-center justify-between px-2.5 pt-1.5 text-[11px] font-medium tracking-[0.08em] text-fg-faint uppercase">
                {label}
                {(kind === "component" || kind === "flow" || kind === "gaps") && (
                  <span
                    className={cn(
                      "tnum font-mono text-xs tracking-normal",
                      kind === "gaps" && count > 0 && "text-amber",
                    )}
                  >
                    {count}
                  </span>
                )}
              </h2>
              {rows.map((e) => (
                <Row key={e.summary.id} entry={e} on={e.summary.id === selected} onSelect={onSelect} />
              ))}
            </section>
          );
        })}
      </div>
    </ListPane>
  );
}

function Row({ entry, on, onSelect }: { entry: ListEntry; on: boolean; onSelect: (id: WikiPageId) => void }) {
  const { summary, page, stale } = entry;
  const kind = summary.kind;
  return (
    <button
      type="button"
      data-page={summary.id}
      aria-current={on ? "page" : undefined}
      onClick={() => onSelect(summary.id)}
      className={cn(ROW, "min-h-[46px] flex-col justify-center gap-0.5 px-2.5 py-1.5", on && ROW_SELECTED)}
    >
      <span
        className={cn("w-full truncate text-body font-medium", on ? "text-fg" : "text-fg-soft")}
        title={summary.title}
      >
        {kind === "gaps" ? "Open items" : summary.title}
      </span>
      {stale ? (
        <StaleMark />
      ) : (
        page !== undefined && (
          <span
            className={cn("w-full truncate text-xs text-fg-faint", kind === "component" && "font-mono")}
            title={subline(page)}
          >
            {subline(page)}
          </span>
        )
      )}
    </button>
  );
}
