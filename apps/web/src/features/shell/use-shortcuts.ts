import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { buildColumns } from "@/features/board/model";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { useTasks } from "@/lib/task-queries";
import { CHORD_MS, resolveShortcut } from "./shortcuts";

/**
 * Keys belong to the captain drawer while it is open and focus is in it, or nowhere yet (it is
 * still opening): single-key shortcuts must not fire then.
 */
function inCaptainDrawer(target: HTMLElement): boolean {
  if (target.closest("[data-captain-drawer]") !== null) return true;
  const open = document.querySelector("[data-captain-drawer]") !== null;
  return open && (target === document.body || target === document.documentElement);
}

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return inCaptainDrawer(target) || target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest('dialog, [role="menu"], [role="listbox"]') !== null;
}

/** The ids of the open tasks in board order: the order `]` and `[` walk. */
export function openTaskIds(tasks: Parameters<typeof buildColumns>[0], org: string | undefined): string[] {
  return buildColumns(tasks, { org, query: "" })
    .filter((c) => c.id !== "done")
    .flatMap((c) => c.tasks.map((t) => t.id));
}

/** The id after (or before) `current` in `ids`, wrapping around. Undefined when there is nothing to go to. */
export function neighbour(
  ids: readonly string[],
  current: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const at = current === undefined ? -1 : ids.indexOf(current);
  if (at < 0) return step === 1 ? ids[0] : ids.at(-1);
  return ids[(at + step + ids.length) % ids.length];
}

/** Opens the review card's main button, the way a click does, so its own choices still follow. */
function approve(): void {
  document.querySelector<HTMLElement>("[data-primary-action]")?.click();
}

/**
 * Global keys, all read from the table in `shortcuts.ts`. Ignored while the owner types in a
 * field or a dialog or menu is open, except the ones the table marks as working there.
 * Returns the state of the shortcuts list and the palette.
 */
export function useShortcuts(onNewTask: () => void): {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
} {
  const navigate = useNavigate();
  const { org } = useOrgFilter();
  const tasks = useTasks().data;
  const { taskId } = useParams({ strict: false }) as { taskId?: string };
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const goAt = useRef(0);
  const latest = useRef({ onNewTask, org, tasks, taskId });
  latest.current = { onNewTask, org, tasks, taskId };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const typing = typingTarget(event.target);
      // Presses that work in fields are checked first; the others wait for a free keyboard.
      const afterG = Date.now() - goAt.current < CHORD_MS;
      const action = resolveShortcut(event, afterG, typing);
      if (action.id === "none") {
        goAt.current = 0;
        return;
      }
      if (action.id === "palette") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      // The captain chat and the message box handle their own keys (`boss-context.tsx`, `composer.tsx`).
      if (action.id === "boss" || action.id === "send") return;
      if (event.defaultPrevented || insideOverlay(event.target)) return;
      goAt.current = 0;
      const { onNewTask: newTask, org: filter, tasks: list, taskId: current } = latest.current;
      switch (action.id) {
        case "wait-for-go":
          goAt.current = Date.now();
          break;
        case "new-task":
          event.preventDefault();
          newTask();
          break;
        case "help":
          event.preventDefault();
          setHelpOpen(true);
          break;
        case "next-task":
        case "prev-task": {
          if (current === undefined) break;
          const to = neighbour(openTaskIds(list ?? [], filter), current, action.id === "next-task" ? 1 : -1);
          if (to === undefined || to === current) break;
          event.preventDefault();
          void navigate({ to: "/t/$taskId", params: { taskId: to }, search: orgSearch(filter) });
          break;
        }
        case "approve":
          if (current === undefined) break;
          event.preventDefault();
          approve();
          break;
        default:
          if (action.go) {
            event.preventDefault();
            void navigate({ to: action.go, search: orgSearch(filter) });
          }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return { helpOpen, setHelpOpen, paletteOpen, setPaletteOpen };
}
