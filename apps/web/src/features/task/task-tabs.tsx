import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/cn";

export type TaskTab = "room" | "changes" | "memory" | "terminal";

export const TAB_PANEL_ID = "task-tab-panel";

const LABEL: Record<TaskTab, string> = {
  room: "Room",
  changes: "Changes",
  memory: "Memory",
  terminal: "Terminal",
};

export function tabId(tab: TaskTab): string {
  return `task-tab-${tab}`;
}

/**
 * The task's tab bar, set along the bottom edge of the header: the selected tab sits on an accent
 * underline. Arrow keys move between tabs, as in any tab list.
 */
export function TaskTabs({
  tabs,
  value,
  onChange,
}: {
  tabs: readonly TaskTab[];
  value: TaskTab;
  onChange: (tab: TaskTab) => void;
}) {
  const refs = useRef(new Map<TaskTab, HTMLButtonElement>());

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(value) + step + tabs.length) % tabs.length];
    if (next === undefined) return;
    onChange(next);
    refs.current.get(next)?.focus();
  }

  return (
    <div role="tablist" aria-label="Task views" onKeyDown={onKeyDown} className="flex items-end gap-1">
      {tabs.map((tab) => {
        const on = tab === value;
        return (
          <button
            key={tab}
            ref={(el) => {
              if (el) refs.current.set(tab, el);
              else refs.current.delete(tab);
            }}
            id={tabId(tab)}
            type="button"
            role="tab"
            aria-selected={on}
            aria-controls={TAB_PANEL_ID}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(tab)}
            className={cn(
              "relative h-9 cursor-pointer px-2.5 text-base transition-colors duration-150",
              "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:transition-colors",
              on ? "font-medium text-fg after:bg-accent" : "text-fg-muted after:bg-transparent hover:text-fg",
            )}
          >
            {LABEL[tab]}
          </button>
        );
      })}
    </div>
  );
}
