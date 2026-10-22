import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/cn";

export type TaskTab = "room" | "brief" | "changes" | "report" | "terminal";

export const TAB_PANEL_ID = "task-tab-panel";

const LABEL: Record<TaskTab, string> = {
  room: "Room",
  brief: "Brief",
  changes: "Changes",
  report: "Report",
  terminal: "Terminal",
};

export function tabId(tab: TaskTab): string {
  return `task-tab-${tab}`;
}

/**
 * The task's tabs, in the middle of its one-row header: the selected tab is a pill. Arrow keys move
 * between tabs, as in any tab list.
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
    <div
      role="tablist"
      aria-label="Task views"
      onKeyDown={onKeyDown}
      className="flex shrink-0 items-center gap-0.5"
    >
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
              "h-7 cursor-pointer rounded-md px-2.5 text-base transition-colors duration-150",
              on
                ? "bg-selected font-medium text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
                : "text-fg-muted hover:bg-raised hover:text-fg",
            )}
          >
            {LABEL[tab]}
          </button>
        );
      })}
    </div>
  );
}
