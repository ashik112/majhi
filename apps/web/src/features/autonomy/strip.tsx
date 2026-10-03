import { useRouterState } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { PAGE_PATH } from "@/lib/pages";
import { seenSummary } from "./model";

/** The strip carries the mode's lamp in its frame, like a lit card. */
const LIT = {
  working:
    "border-lamp-working/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-working)_7%,transparent),transparent_70%)]",
  paused:
    "border-lamp-paused/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-paused)_7%,transparent),transparent_70%)]",
} as const;

/**
 * Shown only when Autonomous has something to say on every page: what holds it (a budget, an
 * account under its floor) or a new daily summary. Its state, spend and switch live in the sidebar
 * and on the Captain page, so the strip does not repeat them.
 */
export function AutonomyStrip() {
  const status = useAutonomyStatus().data;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  if (!status || status.mode === "off" || pathname === PAGE_PATH.captain) return null;
  const hold = status.holds[0]?.text;
  const summary = status.summary;
  const fresh = summary !== undefined && seenSummary() !== summary.day;
  if (hold === undefined && !fresh) return null;

  return (
    <section
      aria-label="Autonomous"
      className={cn("mb-3 flex h-11 shrink-0 items-center gap-3 rounded-xl px-4", GLASS, LIT.paused)}
    >
      <Lamp state={hold === undefined ? "working" : "paused"} />
      <span className="shrink-0 text-base font-medium text-fg">Autonomous</span>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line-strong" />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          hold === undefined ? "text-fg-muted" : LAMP_TEXT.paused,
        )}
      >
        {hold ?? "A new daily summary is ready."}
      </span>
      <Button size="sm" asChild>
        <PageLink page="captain" search={{ tab: "today" }}>
          {hold === undefined ? "Read summary" : "Open"}
        </PageLink>
      </Button>
    </section>
  );
}
