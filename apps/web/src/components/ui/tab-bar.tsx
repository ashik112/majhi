import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A row of tabs set along the bottom edge of a page header: the selected tab sits on an accent
 * underline. Arrow keys move between tabs, as in any tab list.
 */
export function TabBar<T extends string>({
  label,
  tabs,
  value,
  onChange,
  panelId,
}: {
  label: string;
  tabs: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (tab: T) => void;
  /** The id of the panel the tabs control. */
  panelId?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = tabs.findIndex((t) => t.id === value);
    const next = tabs[(at + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    onChange(next.id);
    refs.current.get(next.id)?.focus();
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex items-end gap-1">
      {tabs.map((tab) => {
        const on = tab.id === value;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              if (el) refs.current.set(tab.id, el);
              else refs.current.delete(tab.id);
            }}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              "relative h-9 cursor-pointer px-2.5 text-base transition-colors duration-150",
              "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors",
              on ? "font-medium text-fg after:bg-accent" : "text-fg-muted after:bg-transparent hover:text-fg",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
