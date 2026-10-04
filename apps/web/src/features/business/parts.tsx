import { PRIVATE } from "@majhi/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { useOrgs } from "@/lib/studio-queries";

/** The scopes a row can live in: the whole business (empty value), Private and each client workspace. */
export interface Scope {
  value: string;
  label: string;
}

export const BUSINESS_SCOPE: Scope = { value: "", label: "Whole business" };

export function useScopes(): Scope[] {
  const orgs = useOrgs().data;
  return useMemo(() => {
    const named = (orgs ?? []).map((o) => ({ value: o.id, label: o.name }));
    const hasPrivate = named.some((s) => s.value === PRIVATE);
    return [BUSINESS_SCOPE, ...(hasPrivate ? [] : [{ value: PRIVATE, label: "Private" }]), ...named];
  }, [orgs]);
}

export function scopeLabel(scopes: readonly Scope[], org: string | undefined): string {
  return scopes.find((s) => s.value === (org ?? ""))?.label ?? org ?? BUSINESS_SCOPE.label;
}

/** A small pill naming where a row lives; the whole business reads as plain text, not a pill. */
export function ScopeTag({ label, business }: { label: string; business: boolean }) {
  return (
    <span
      className={cn(
        "max-w-[40%] shrink-0 truncate text-xs",
        business ? "text-fg-faint" : "rounded-full border border-line-control px-2 py-px text-fg-muted",
      )}
      title={label}
    >
      {label}
    </span>
  );
}

/** The filter above a list: "" is everything, `business` the business-wide rows, else one workspace's. */
export function ScopeFilter({
  value,
  onChange,
  scopes,
}: {
  value: string;
  onChange: (value: string) => void;
  scopes: readonly Scope[];
}) {
  return (
    <Select
      aria-label="Workspace"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 flex-1 text-sm"
    >
      <option value="*">All workspaces</option>
      <option value="">Whole business only</option>
      {scopes
        .filter((s) => s.value !== "")
        .map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
    </Select>
  );
}

/** Whether a row in `org` shows under a filter value (`*` all, `` business only, else that workspace plus business). */
export function inScope(filter: string, org: string | undefined): boolean {
  if (filter === "*") return true;
  if (filter === "") return org === undefined;
  return org === undefined || org === filter;
}

/**
 * The list side of every Business pane: a glass column with a search box and filters on top, rows that
 * scroll inside it and an optional footer. `/` jumps to the search.
 */
export function ListShell({
  label,
  search,
  onSearch,
  placeholder,
  filters,
  footer,
  children,
}: {
  label: string;
  search: string;
  onSearch: (value: string) => void;
  placeholder: string;
  filters?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const box = useRef<HTMLInputElement>(null);
  return (
    <nav
      aria-label={label}
      onKeyDown={(e) => {
        const t = e.target as HTMLElement;
        if (e.key === "/" && t.tagName !== "INPUT" && t.tagName !== "TEXTAREA") {
          e.preventDefault();
          box.current?.focus();
        }
      }}
      className={cn(
        "flex w-[296px] shrink-0 flex-col overflow-hidden rounded-2xl min-[1320px]:w-[340px]",
        GLASS,
      )}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-faint"
          />
          <Input
            ref={box}
            aria-label={placeholder}
            placeholder={placeholder}
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.currentTarget.blur();
                if (search !== "") onSearch("");
              }
            }}
            className="h-8 pr-8 pl-8 text-sm"
          />
          <Kbd className="absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
        </div>
        {filters && <div className="flex min-w-0 items-center gap-2">{filters}</div>}
      </div>
      {children}
      {footer && <div className="shrink-0 border-t border-line p-2">{footer}</div>}
    </nav>
  );
}

/**
 * A long list that renders only the rows on screen. The scroller is the one tab stop: arrows or j and k
 * move the selection, Home and End jump, and the selected row stays in view.
 */
export function VirtualRows<T>({
  label,
  items,
  getId,
  selectedId,
  onSelect,
  estimate = 52,
  row,
  onKey,
}: {
  label: string;
  items: readonly T[];
  getId: (item: T) => string | number;
  selectedId: string | number | undefined;
  onSelect: (id: string | number) => void;
  estimate?: number;
  row: (item: T, selected: boolean) => ReactNode;
  /** Keys the pane handles itself (n, e, Delete). */
  onKey?: (e: React.KeyboardEvent, selected: T | undefined) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimate,
    overscan: 10,
    getItemKey: (i) => {
      const item = items[i];
      return item === undefined ? i : getId(item);
    },
  });
  const index = items.findIndex((i) => getId(i) === selectedId);
  // The first row is selected when the list changes, so the keys work at once.
  useEffect(() => {
    const first = items[0];
    if (first !== undefined && index < 0) onSelect(getId(first));
  }, [items, index, getId, onSelect]);

  const move = (to: number) => {
    const clamped = Math.max(0, Math.min(items.length - 1, to));
    const next = items[clamped];
    if (next === undefined) return;
    onSelect(getId(next));
    virtual.scrollToIndex(clamped);
  };
  return (
    <div
      ref={scroller}
      role="listbox"
      aria-label={label}
      aria-activedescendant={selectedId === undefined ? undefined : `biz-row-${selectedId}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === "ArrowDown" || e.key === "j") {
          e.preventDefault();
          move(index + 1);
        } else if (e.key === "ArrowUp" || e.key === "k") {
          e.preventDefault();
          move(index - 1);
        } else if (e.key === "Home") {
          e.preventDefault();
          move(0);
        } else if (e.key === "End") {
          e.preventDefault();
          move(items.length - 1);
        } else onKey?.(e, items[index]);
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 py-1.5 outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--c-accent)]"
    >
      <div style={{ height: virtual.getTotalSize() }} className="relative w-full">
        {virtual.getVirtualItems().map((v) => {
          const item = items[v.index];
          if (item === undefined) return null;
          const id = getId(item);
          return (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox owns the keys
            <div
              key={v.key}
              id={`biz-row-${id}`}
              role="option"
              aria-selected={id === selectedId}
              tabIndex={-1}
              ref={virtual.measureElement}
              data-index={v.index}
              onClick={() => onSelect(id)}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${v.start}px)` }}
            >
              {row(item, id === selectedId)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One row's frame: the selected tint and inset ring of the app's lists. */
export function RowFrame({ selected, children }: { selected: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-w-0 cursor-pointer flex-col gap-1 rounded-md px-2.5 py-2 transition-colors duration-150 hover:bg-raised",
        selected && "bg-selected shadow-[inset_0_0_0_1px_var(--c-line-control)]",
      )}
    >
      {children}
    </div>
  );
}

/** Says what this pane is for and the one next step. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-2 px-6 py-8">
      <h2 className="text-md font-semibold text-fg">{title}</h2>
      <p className="max-w-[46ch] text-base text-fg-muted text-pretty">{body}</p>
      {action && (
        <Button variant="primary" onClick={action.onClick} className="mt-1">
          {action.label}
        </Button>
      )}
    </div>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-red text-pretty">
      {children}
    </p>
  );
}

/** Mono, dim, for ids, dates and counts in a row. */
export function Meta({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return <span className={cn("tnum font-mono text-xs text-fg-faint", className)}>{children}</span>;
}
