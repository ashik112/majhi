import { type TaskPriority, TaskPrioritySchema } from "@majhi/shared";
import { EllipsisVertical } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "@/components/ui/anchored";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { GLASS_STRONG } from "@/lib/glass";
import { useUpdateTask } from "@/lib/task-queries";
import { useNow } from "@/lib/use-now";
import { daysUntil, dueInfo, duePicks, PRIORITY_LABEL, shortDay } from "./schedule";

/** What the editors need of a task: a full task and a board row both have it. */
export interface Scheduled {
  id: string;
  priority?: TaskPriority | undefined;
  due?: string | undefined;
}

/** Saves a change to the priority or the due date; null clears it. Errors become a toast. */
function useSchedule(task: Scheduled) {
  const update = useUpdateTask();
  const toast = useToast();
  const save = useCallback(
    (patch: { priority?: TaskPriority | null; due?: string | null }) =>
      update.mutate(
        { id: task.id, ...patch },
        { onError: (e) => toast("Could not change the task", { detail: e.message, tone: "error" }) },
      ),
    [task.id, toast, update.mutate],
  );
  return save;
}

/** A day the date field may save: a real date within a year back and ten years ahead, not one half typed. */
function plausibleDay(day: string, now: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const days = daysUntil(day, now);
  return !Number.isNaN(days) && days >= -366 && days <= 3660;
}

/**
 * The floating panel that sets a task's priority and due date. Every choice saves at once; the date
 * field saves as soon as it holds a whole date.
 */
export function SchedulePanel({
  task,
  open,
  close,
  anchor,
  align = "left",
  focusDate = false,
}: {
  task: Scheduled;
  open: boolean;
  close: () => void;
  anchor: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  /** Puts focus in the date field, for "Pick a date" from a card's menu. */
  focusDate?: boolean;
}) {
  const save = useSchedule(task);
  const now = useNow(60_000);
  const dateRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string>();
  const { panel, style, container } = useAnchoredPanel({
    open,
    close,
    trigger: anchor,
    align,
    maxHeight: 360,
  });
  const priority = task.priority ?? "normal";

  // The panel is hidden until it is placed, and a hidden field cannot take focus: wait a frame.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (focusDate) dateRef.current?.focus();
      else panel.current?.querySelector<HTMLElement>("button[aria-pressed='true']")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, focusDate, panel]);

  if (!open) return null;
  const setDue = (day: string | null) => {
    setDraft(undefined);
    if (day === (task.due ?? null)) return;
    save({ due: day });
  };

  return createPortal(
    <div
      ref={panel}
      popover="manual"
      role="dialog"
      aria-label={`Priority and due date of ${task.id}`}
      style={style}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        close();
        anchor.current?.querySelector<HTMLElement>("button")?.focus();
      }}
      className={cn("z-50 flex w-[276px] flex-col gap-3 rounded-lg p-3", GLASS_STRONG)}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-faint">Priority</span>
        <Segmented
          label="Priority"
          value={priority}
          onChange={(value) => {
            const next = TaskPrioritySchema.parse(value);
            if (next !== priority) save({ priority: next === "normal" ? null : next });
          }}
          segments={(["high", "normal", "low"] as const).map((p) => ({ value: p, label: PRIORITY_LABEL[p] }))}
          className="[&>button]:flex-1"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-fg-faint">Due date</span>
        <div className="flex gap-1.5">
          {duePicks(now).map((pick) => (
            <ChoiceChip
              key={pick.label}
              pressed={task.due === pick.day}
              title={shortDay(pick.day, now)}
              onClick={() => setDue(pick.day)}
              className="min-h-7 flex-1 px-2"
            >
              {pick.label}
            </ChoiceChip>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            ref={dateRef}
            type="date"
            aria-label="Due date"
            value={draft ?? task.due ?? ""}
            onChange={(e) => {
              const day = e.target.value;
              setDraft(day);
              if (plausibleDay(day, now)) setDue(day);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && draft !== undefined && plausibleDay(draft, now)) setDue(draft);
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-line-control bg-field px-2 text-sm text-fg [color-scheme:inherit] transition-[border-color] duration-150 hover:border-line-hover focus-visible:border-accent focus-visible:outline-none"
          />
          {task.due !== undefined && (
            <button
              type="button"
              onClick={() => setDue(null)}
              className="h-7 shrink-0 cursor-pointer rounded-md px-2 text-sm text-fg-muted hover:bg-raised hover:text-fg"
            >
              Clear
            </button>
          )}
        </div>
        {task.due !== undefined && (
          <span className="text-xs text-fg-faint">{dueInfo(task.due, now).text}</span>
        )}
      </div>
    </div>,
    container,
  );
}

/**
 * A board card's "..." menu: priority and due date in one place, with quick days and a date field
 * for any other day.
 */
export function CardMenu({ task, className }: { task: Scheduled; className?: string }) {
  const save = useSchedule(task);
  const now = useNow(60_000);
  const [picking, setPicking] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setPicking(false), []);
  const priority = task.priority ?? "normal";
  const picks = duePicks(now);
  const custom = task.due !== undefined && !picks.some((p) => p.day === task.due);
  const items: MenuItem[] = [
    ...(["high", "normal", "low"] as const).map((p) => ({
      label: PRIORITY_LABEL[p],
      group: "Priority",
      checked: priority === p,
      onSelect: () => {
        if (p !== priority) save({ priority: p === "normal" ? null : p });
      },
    })),
    ...picks.map((pick) => ({
      label: `${pick.label}, ${shortDay(pick.day, now)}`,
      group: "Due",
      checked: task.due === pick.day,
      onSelect: () => {
        if (task.due !== pick.day) save({ due: pick.day });
      },
    })),
    {
      label: custom && task.due !== undefined ? `${shortDay(task.due, now)}, change` : "Pick a date",
      group: "Due",
      checked: custom,
      onSelect: () => setPicking(true),
    },
    {
      label: "No due date",
      group: "Due",
      checked: task.due === undefined,
      onSelect: () => {
        if (task.due !== undefined) save({ due: null });
      },
    },
  ];
  return (
    <span ref={anchor} data-open={picking ? "" : undefined} className={cn("relative z-10 flex", className)}>
      <Menu
        label={`Menu of ${task.id}`}
        align="right"
        maxHeight={420}
        items={items}
        trigger={(props) => (
          <button
            type="button"
            aria-label={`Menu of ${task.id}`}
            title="Priority and due date"
            {...props}
            className="grid size-5 cursor-pointer place-items-center rounded-sm text-fg-muted hover:bg-raised hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          >
            <EllipsisVertical aria-hidden="true" className="size-3.5" />
          </button>
        )}
      />
      <SchedulePanel task={task} open={picking} close={close} anchor={anchor} align="right" focusDate />
    </span>
  );
}
