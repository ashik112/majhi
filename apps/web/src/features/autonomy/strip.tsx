import { useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { LAMP_TEXT, Lamp } from "@/components/ui/lamp";
import { PageLink } from "@/components/ui/page-link";
import { useAutonomyStatus } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { PAGE_PATH } from "@/lib/pages";
import { OffDialog, useAutonomyActions } from "./controls";
import { MODE_LAMP, MODE_WORD, seenSummary, todayLine } from "./model";
import { TaskRef } from "./task-ref";

/** The strip carries the mode's lamp in its frame, like a lit card. */
const LIT = {
  working:
    "border-lamp-working/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-working)_7%,transparent),transparent_70%)]",
  paused:
    "border-lamp-paused/30 bg-[linear-gradient(180deg,color-mix(in_oklab,var(--c-lamp-paused)_7%,transparent),transparent_70%)]",
} as const;

/**
 * While autonomous mode is not off, this strip sits at the top of every page and cannot be closed:
 * the mode, what runs first, today's spend against the day cap, and Pause or Resume, Stop and Open.
 */
export function AutonomyStrip() {
  const status = useAutonomyStatus().data;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const actions = useAutonomyActions();
  const [stopOpen, setStopOpen] = useState(false);
  // The Autonomous page has its own status bar with the same readout and controls.
  if (!status || status.mode === "off" || pathname === PAGE_PATH.autonomous) return null;

  const mode = status.mode;
  const lamp = MODE_LAMP[mode];
  const first = status.now[0];
  const agent = first?.agents.find((a) => a.nowDoing !== undefined) ?? first?.agents[0];
  const onPage = pathname === PAGE_PATH.autonomous;
  const summary = status.summary;
  const fresh = summary !== undefined && !onPage && seenSummary() !== summary.day;
  const boss = status.boss;
  const idle =
    status.holds[0]?.text ??
    (boss?.nowDoing !== undefined
      ? `@${boss.id} ${boss.nowDoing}`
      : boss?.working
        ? `@${boss.id} is working`
        : "Nothing runs now. The captain picks what comes next.");

  return (
    <section
      aria-label="Autonomous mode"
      className={cn(
        "mb-3 flex h-11 shrink-0 items-center gap-3 rounded-xl px-4",
        GLASS,
        lamp === "paused" ? LIT.paused : LIT.working,
      )}
    >
      <Lamp state={lamp} />
      <span className="shrink-0 text-base font-medium text-fg">Autonomous</span>
      <span className={cn("shrink-0 text-sm", LAMP_TEXT[lamp])}>{MODE_WORD[mode]}</span>
      <span aria-hidden="true" className="h-4 w-px shrink-0 bg-line-strong" />
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {first ? (
          <>
            <TaskRef task={first.task} />
            <span className="min-w-0 truncate text-fg-soft">
              {first.title}
              {agent?.nowDoing !== undefined && (
                <span className="text-fg-muted">
                  : @{agent.id} {agent.nowDoing}
                </span>
              )}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate text-fg-muted">{idle}</span>
        )}
      </span>
      <span
        title="Autonomous spend today against its day budget"
        className="tnum shrink-0 text-sm text-fg-soft"
      >
        {todayLine(status.spend.total)}
      </span>
      {fresh && (
        <PageLink page="autonomous" className="shrink-0 text-sm text-blue hover:underline">
          New daily summary
        </PageLink>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => setStopOpen(true)}>
          Turn off
        </Button>
        {!onPage && (
          <Button size="sm" asChild>
            <PageLink page="autonomous">Open</PageLink>
          </Button>
        )}
      </div>
      {stopOpen && <OffDialog status={status} onClose={() => setStopOpen(false)} />}
    </section>
  );
}
