import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { isStudioShortcut } from "./model";

/** Opens Studio with Ctrl or Cmd plus a period, from any screen. */
export function useStudioShortcut(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isStudioShortcut(event)) return;
      event.preventDefault();
      void navigate({ to: "/studio/$tab", params: { tab: "agents" }, search: {} });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate]);
}
