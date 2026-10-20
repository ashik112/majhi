import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { pressMatches, shortcut } from "@/features/shell/shortcuts";
import { useOrgFilter } from "@/lib/org-filter";

interface BossControls {
  /**
   * Opens the captain's chat in the console. `org` picks the workspace it is scoped to (the top bar's filter,
   * the one place that says it); `"all"` is the whole desk. Without `org` the filter stays as it is.
   */
  show: (opts?: { org?: string | "all"; draft?: string }) => void;
  /** Text waiting to be put in the message box (an incident to ask about), taken once. */
  draft: string | undefined;
  takeDraft: () => void;
}

const BossContext = createContext<BossControls | null>(null);

/** Which tab the captain's chat shows, text waiting for its box, and Cmd+J (Ctrl+J elsewhere) to open it from any page. */
export function BossProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { setOrg } = useOrgFilter();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const takeDraft = useCallback(() => setDraft(undefined), []);
  const show = useCallback(
    (opts?: { org?: string | "all"; draft?: string }) => {
      if (opts?.org !== undefined) setOrg(opts.org === "all" ? undefined : opts.org);
      if (opts?.draft !== undefined) setDraft(opts.draft);
      void navigate({ to: "/", search: { chat: "captain" } });
    },
    [navigate, setOrg],
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

  const value = useMemo(() => ({ show, draft, takeDraft }), [show, draft, takeDraft]);
  return <BossContext.Provider value={value}>{children}</BossContext.Provider>;
}

export function useBoss(): BossControls {
  const value = useContext(BossContext);
  if (value === null) throw new Error("useBoss needs a BossProvider");
  return value;
}
