import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence } from "motion/react";
import * as m from "motion/react-m";
import type { Banner, BannerAction } from "@/features/shell/model";
import { cn } from "@/lib/cn";
import { orgSearch } from "@/lib/org-filter";

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

/** The strip above the page. It appears only when something needs the owner, and slides in. */
export function AttentionBanner({ banner, org }: { banner: Banner | null; org: string | undefined }) {
  const navigate = useNavigate();

  function run(action: BannerAction) {
    if (action.kind === "task")
      void navigate({ to: "/t/$taskId", params: { taskId: action.id }, search: orgSearch(org) });
    else if (action.kind === "chat")
      void navigate({ to: "/chats/$taskId", params: { taskId: action.id }, search: orgSearch(org) });
    else if (action.kind === "page")
      void navigate({ to: action.to, search: { ...orgSearch(org), ...action.search } });
    else {
      const el = document.getElementById(action.id);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus({ preventScroll: true });
    }
  }

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
              {banner.more > 0 && <span className="opacity-70"> and {banner.more} more need you.</span>}
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
