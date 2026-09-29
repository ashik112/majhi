import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";

interface BossControls {
  open: boolean;
  show: () => void;
  hide: () => void;
  toggle: () => void;
}

const BossContext = createContext<BossControls | null>(null);

/** Whether the boss drawer is open, and Cmd+J (Ctrl+J elsewhere) to toggle it from any page. */
export function BossProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.isComposing || event.altKey || event.shiftKey) return;
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = useMemo(() => ({ open, show, hide, toggle }), [open, show, hide, toggle]);
  return <BossContext.Provider value={value}>{children}</BossContext.Provider>;
}

export function useBoss(): BossControls {
  const value = useContext(BossContext);
  if (value === null) throw new Error("useBoss needs a BossProvider");
  return value;
}
