import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import type { Banner, BannerAction } from "@/features/shell/model";
import { cn } from "@/lib/cn";
import { setNoticesOpen } from "@/lib/notices";

const TONE = {
  amber: {
    box: "border-amber-line bg-amber-wash text-amber-soft",
    dot: "bg-amber-soft",
    hover: "hover:bg-amber-soft/10",
  },
  red: {
    box: "border-red-line bg-red-wash text-red-soft",
    dot: "bg-red-soft",
    hover: "hover:bg-red-soft/10",
  },
} as const;

/** Opens what an attention item points at: its task or chat, a page, or a prompt on this page. */
export function useRunAttention(): (action: BannerAction) => void {
  const navigate = useNavigate();
  return (action) => {
    if (action.kind === "task")
      void navigate({
        to: "/t/$taskId",
        params: { taskId: action.id },
        search: action.item === undefined ? {} : { item: action.item },
      });
    else if (action.kind === "chat") void navigate({ to: "/chats/$taskId", params: { taskId: action.id } });
    else if (action.kind === "page") void navigate({ to: action.to, search: { ...action.search } });
    else {
      const el = document.getElementById(action.id);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    }
  };
}

/**
 * The strip above the page: the one thing that needs the owner most. It appears only then, and
 * slides in. "And 3 more" opens the notifications panel with the rest.
 */
export function AttentionBanner({ banner }: { banner: Banner | null }) {
  const run = useRunAttention();
  // The banner shows the first; `more` counts the rest that are not drawn on the page.
  const more = banner?.more ?? 0;

  return (
    <AnimatePresence initial={false}>
      {banner && (
        <m.div
          key="banner"
          role="status"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 56, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="shrink-0 overflow-hidden"
        >
          <div
            className={cn(
              "flex h-11 items-center gap-3 rounded-xl border px-5 backdrop-blur-xl",
              TONE[banner.tone].box,
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 shrink-0 rounded-full shadow-[0_0_8px_currentColor]",
                TONE[banner.tone].dot,
              )}
            />
            <span className="min-w-0 truncate text-base">
              {banner.text}
              {more > 0 && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={() => setNoticesOpen(true)}
                    className="cursor-pointer opacity-70 underline-offset-2 hover:underline hover:opacity-100"
                  >
                    And {more} more need you.
                  </button>
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => run(banner.action)}
              className={cn(
                "ml-auto h-[30px] shrink-0 cursor-pointer rounded-sm border border-current bg-transparent px-3 text-sm transition-colors duration-150",
                TONE[banner.tone].hover,
              )}
            >
              {banner.actionLabel}
            </button>
          </div>
        </m.div>
      )}
    </AnimatePresence>
  );
}
