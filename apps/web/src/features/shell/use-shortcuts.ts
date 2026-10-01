import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { orgSearch, useOrgFilter } from "@/lib/org-filter";
import { CHORD_MS, resolveShortcut } from "./shortcuts";

function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  return target.closest('dialog, [role="menu"], [role="listbox"]') !== null;
}

/**
 * Global keys: Cmd K the palette, `n` new task, `g` then a letter to go to a page, `?` for the list. Ignored while the
 * owner types or a dialog or menu is open. Returns the state of the shortcuts dialog.
 */
export function useShortcuts(onNewTask: () => void): {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
} {
  const navigate = useNavigate();
  const { org } = useOrgFilter();
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const goAt = useRef(0);
  const latest = useRef({ onNewTask, org });
  latest.current = { onNewTask, org };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Cmd or Ctrl K opens the palette from anywhere, fields included.
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.defaultPrevented || typingTarget(event.target)) return;
      const afterG = Date.now() - goAt.current < CHORD_MS;
      const action = resolveShortcut(event, afterG);
      goAt.current = 0;
      switch (action.type) {
        case "wait-for-go":
          goAt.current = Date.now();
          break;
        case "go":
          event.preventDefault();
          void navigate({ to: action.to, search: orgSearch(latest.current.org) });
          break;
        case "new-task":
          event.preventDefault();
          latest.current.onNewTask();
          break;
        case "help":
          event.preventDefault();
          setHelpOpen(true);
          break;
        case "none":
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  return { helpOpen, setHelpOpen, paletteOpen, setPaletteOpen };
}
