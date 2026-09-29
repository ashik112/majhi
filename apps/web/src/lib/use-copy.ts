import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";

/** Copies text to the clipboard and confirms with a toast that echoes what was copied. */
export function useCopy() {
  const toast = useToast();
  return useCallback(
    async (text: string, shown: string = text) => {
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied", { detail: shown });
      } catch {
        toast("Could not copy", { detail: "The browser blocked clipboard access", tone: "error" });
      }
    },
    [toast],
  );
}
