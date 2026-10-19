import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { pressMatches, shortcut } from "@/features/shell/shortcuts";

/** The Captain chat's tabs: the owner's own chat, every thread merged, or one workspace's thread. */
export type PanelTab = "talk" | "all" | `ws:${string}` | `urgent:${string}`;

interface BossControls {
  /** Opens the captain's chat in the console, on a tab when one is given. */
  show: (tab?: PanelTab, draft?: string) => void;
  /** The tab the chat shows. */
  tab: PanelTab;
  setTab: (tab: PanelTab) => void;
  /** Text waiting to be put in the message box (an incident to ask about), taken once. */
  draft: string | undefined;
  takeDraft: () => void;
}

const BossContext = createContext<BossControls | null>(null);

/** Which tab the captain's chat shows, text waiting for its box, and Cmd+J (Ctrl+J elsewhere) to open it from any page. */
export function BossProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<PanelTab>("talk");
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const takeDraft = useCallback(() => setDraft(undefined), []);
  const show = useCallback(
    (next?: PanelTab, text?: string) => {
      if (next !== undefined) setTab(next);
      if (text !== undefined) setDraft(text);
      void navigate({ to: "/", search: { chat: "captain" } });
    },
    [navigate],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const press = shortcut("boss").press;
      if (press === undefined || !pressMatches(press, event)) return;
      event.preventDefault();
      void navigate({ to: "/", search: { chat: "captain" } });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  const value = useMemo(() => ({ show, tab, setTab, draft, takeDraft }), [show, tab, draft, takeDraft]);
  return <BossContext.Provider value={value}>{children}</BossContext.Provider>;
}

export function useBoss(): BossControls {
  const value = useContext(BossContext);
  if (value === null) throw new Error("useBoss needs a BossProvider");
  return value;
}
