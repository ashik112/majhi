import type { OnboardingStepId } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, useReducedMotion } from "motion/react";
import * as m from "motion/react-m";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { GLASS } from "@/lib/glass";
import { queryKeys } from "@/lib/queries";
import { RiverScene, type SceneStop } from "./scene/river-scene";
import { savePlace, skippedSteps, skipStep } from "./skip";
import { JourneyProvider } from "./step-frame";
import { onboardingSteps, stepIndex } from "./steps";
import { useJourney } from "./use-journey";

/** How long the boat takes to reach the ghat before the arrive moment lights up. */
const ARRIVE_AFTER_MS = 2600;

/**
 * The first-run journey: the river on the left, the step on the right. The place is saved on every
 * move, so a reload comes back to the same step.
 */
export function OnboardingFlow({
  start,
  onLater,
  onArrive,
}: {
  start: OnboardingStepId;
  /** "Finish later": back to the app, and the journey stops opening by itself. */
  onLater: () => void;
  /** The last step's action: the journey ends on the board. */
  onArrive: () => void;
}) {
  const journey = useJourney();
  const queryClient = useQueryClient();
  const status = journey.status;
  const reduced = useReducedMotion() ?? false;
  const [index, setIndex] = useState(() => stepIndex(start));
  const [skipped, setSkipped] = useState(skippedSteps);
  const [arrived, setArrived] = useState(false);
  const last = onboardingSteps.length - 1;
  // Nothing else can be saved before a folder is set, so the journey stays at Welcome until then.
  const locked = status !== undefined && status.roots.length === 0;
  const shown = locked ? 0 : index;
  const current = onboardingSteps[shown];

  useEffect(() => {
    if (current) savePlace(current.id);
  }, [current]);

  useEffect(() => {
    if (shown !== last) {
      setArrived(false);
      return;
    }
    const timer = window.setTimeout(() => setArrived(true), reduced ? 0 : ARRIVE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [shown, last, reduced]);

  const doneIds = useMemo(
    () => new Set(status?.steps.filter((s) => s.done).map((s) => s.id) ?? []),
    [status],
  );

  const stops: SceneStop[] = onboardingSteps.map((s, i) => ({
    id: s.id,
    title: s.title,
    state: i === shown ? "current" : doneIds.has(s.id) ? "done" : skipped.has(s.id) ? "skipped" : "todo",
  }));

  if (!current) return null;

  const goTo = (target: number) => setIndex(Math.max(0, Math.min(last, target)));
  const leave = (asSkip: boolean) => {
    if (asSkip && current.id !== "finish") {
      skipStep(current.id);
      setSkipped(skippedSteps());
    }
    if (shown === last) onArrive();
    else goTo(shown + 1);
  };
  const { Component } = current;

  return (
    <main className="flex min-h-0 flex-1 gap-3 p-3 max-[860px]:flex-col">
      <div
        className={cn(
          "relative flex shrink-0 overflow-hidden rounded-2xl border border-glass-line shadow-glass",
          "w-[clamp(340px,36vw,540px)] max-[860px]:h-[180px] max-[860px]:w-full",
        )}
      >
        <RiverScene
          className="size-full max-[860px]:[&_nav]:hidden"
          stops={stops}
          current={shown}
          arrived={arrived}
          onPick={(i) => !locked && goTo(i)}
        />
        <div className="pointer-events-none absolute top-4 left-4 flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-[7px] bg-brand font-mono text-sm font-semibold text-brand-ink shadow-[0_4px_14px_-4px_var(--c-brand)]"
          >
            mj
          </span>
          <span className="text-[16px] font-semibold tracking-[-0.01em] text-fg [text-shadow:0_0_8px_var(--rv-label-halo)]">
            majhi
          </span>
        </div>
      </div>

      <section
        aria-labelledby="journey-heading"
        className={cn(GLASS, "flex min-h-0 min-w-0 flex-1 flex-col rounded-2xl px-8 max-[1180px]:px-6")}
      >
        <div className="mx-auto flex min-h-0 w-full max-w-[640px] flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 pt-6 pb-1">
            <p className="m-0 font-mono text-sm text-fg-faint tabular-nums">
              Step {shown + 1} of {onboardingSteps.length}
            </p>
            <Button variant="ghost" size="sm" className="-mr-2.5 ml-auto" onClick={onLater}>
              Finish later
            </Button>
          </header>
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={current.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: reduced ? 0 : 0.32, ease: [0.16, 1, 0.3, 1] }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="my-auto flex max-h-full min-h-0 flex-col pb-[4vh]">
                <div className="flex shrink-0 flex-col gap-2.5 pt-3 pb-7">
                  <h1
                    id="journey-heading"
                    className="m-0 flex items-baseline gap-3 text-xl font-semibold tracking-[-0.012em] text-balance"
                  >
                    {current.heading}
                    {current.aside && (
                      <span lang="bn" className="text-lg font-normal text-fg-faint">
                        {current.aside}
                      </span>
                    )}
                  </h1>
                  <p className="m-0 max-w-[58ch] text-body text-fg-muted text-pretty">{current.why}</p>
                </div>
                {status ? (
                  <JourneyProvider
                    value={{
                      status,
                      done: doneIds.has(current.id),
                      isLast: shown === last,
                      // The step's own Continue: it finished. The status may lag a moment behind, so
                      // only Skip marks a step skipped.
                      next: () => {
                        void queryClient.invalidateQueries({ queryKey: queryKeys.onboarding });
                        leave(false);
                      },
                      skip: () => leave(true),
                      goTo: (id) => goTo(stepIndex(id)),
                    }}
                  >
                    <Component />
                  </JourneyProvider>
                ) : (
                  <StepLoading />
                )}
              </div>
            </m.div>
          </AnimatePresence>
        </div>
      </section>
    </main>
  );
}

function StepLoading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-3">
      <span className="sr-only">Loading</span>
      <Skeleton className="h-11 w-full rounded-lg" />
      <Skeleton className="h-11 w-full rounded-lg" />
      <Skeleton className="h-11 w-2/3 rounded-lg" />
    </div>
  );
}
