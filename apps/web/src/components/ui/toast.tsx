import { Check, CircleAlert } from "lucide-react";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

interface ToastMessage {
  id: number;
  title: string;
  detail?: string | undefined;
  tone: "success" | "error";
}

type ShowToast = (title: string, options?: { detail?: string; tone?: ToastMessage["tone"] }) => void;

const ToastContext = createContext<ShowToast | null>(null);

export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast needs a <ToastProvider> above it");
  return show;
}

/** One toast at a time, bottom center. A new toast replaces the current one. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const nextId = useRef(0);

  const show = useCallback<ShowToast>((title, options) => {
    nextId.current += 1;
    setToast({ id: nextId.current, title, detail: options?.detail, tone: options?.tone ?? "success" });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), toast.tone === "error" ? 4000 : 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-12 z-50 flex justify-center px-4"
      >
        <AnimatePresence mode="popLayout">
          {toast && (
            <m.div
              key={toast.id}
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="flex max-w-[min(560px,100%)] items-center gap-2.5 rounded-lg border border-line-bright bg-glass-strong py-2 pr-3.5 pl-2.5 shadow-pop"
            >
              <span
                className={cn(
                  "flex size-5 shrink-0 items-center justify-center rounded-full",
                  toast.tone === "success" ? "bg-green-wash text-green" : "bg-red-wash text-red",
                )}
              >
                {toast.tone === "success" ? (
                  <Check className="size-3" strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <CircleAlert className="size-3" strokeWidth={2.5} aria-hidden="true" />
                )}
              </span>
              <span className="text-base font-medium text-fg">{toast.title}</span>
              {toast.detail && (
                <span className="min-w-0 truncate font-mono text-sm text-fg-faint">{toast.detail}</span>
              )}
            </m.div>
          )}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
