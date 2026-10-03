import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { pressMatches, shortcut } from "@/features/shell/shortcuts";

/** The Captain panel's tabs: the owner's own chat, every thread merged, or one workspace's thread. */
export type PanelTab = "talk" | "all" | `ws:${string}`;

interface BossControls {
  open: boolean;
  /** Opens the panel, on a tab when one is given. */
  show: (tab?: PanelTab) => void;
  hide: () => void;
  toggle: () => void;
  /** The tab the panel shows, in the drawer and on the Captain page alike. */
  tab: PanelTab;
  setTab: (tab: PanelTab) => void;
}

const BossContext = createContext<BossControls | null>(null);

/** Whether the Captain panel is open, which tab it shows, and Cmd+J (Ctrl+J elsewhere) to toggle it from any page. */
export function BossProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>("talk");
  const show = useCallback((next?: PanelTab) => {
    if (next !== undefined) setTab(next);
    setOpen(true);
  }, []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const press = shortcut("boss").press;
      if (press === undefined || !pressMatches(press, event)) return;
      event.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, show, hide, toggle, tab, setTab }), [open, show, hide, toggle, tab]);
  return <BossContext.Provider value={value}>{children}</BossContext.Provider>;
}

export function useBoss(): BossControls {
  const value = useContext(BossContext);
  if (value === null) throw new Error("useBoss needs a BossProvider");
  return value;
}
