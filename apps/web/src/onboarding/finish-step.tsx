import { ArrowRight, CircleCheck, CircleDashed } from "lucide-react";
import * as m from "motion/react-m";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/cn";
import { MOD_KEY } from "@/lib/format";
import { StepFrame, useStep } from "./step-frame";
import { onboardingSteps } from "./steps";

/**
 * Arrive: the boat reaches the ghat. A short look back at each stop, with a way back to the ones
 * left for later, then the board with the new-task box open.
 */
export function FinishStep() {
  const step = useStep();
  const done = new Set(step.status.steps.filter((s) => s.done).map((s) => s.id));
  const stops = onboardingSteps.filter((s) => s.id !== "finish");
  const left = stops.filter((s) => !done.has(s.id));

  return (
    <StepFrame
      skippable={false}
      note={left.length > 0 ? "Resume setup in Settings > Overview." : undefined}
      primary={
        <Button variant="primary" size="lg" onClick={step.next}>
          Write the first task
          <ArrowRight aria-hidden="true" />
        </Button>
      }
    >
      <div className="flex flex-col gap-6">
        <ul aria-label="Your journey" className="m-0 flex list-none flex-col p-0">
          {stops.map((s, i) => {
            const ok = done.has(s.id);
            return (
              <m.li
                key={s.id}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.12 + i * 0.06, duration: 0.36, ease: [0.16, 1, 0.3, 1] }}
                className="flex min-h-12 items-center gap-3 border-t border-line first:border-t-0"
              >
                {ok ? (
                  <CircleCheck aria-hidden="true" className="size-[18px] shrink-0 text-green" />
                ) : (
                  <CircleDashed aria-hidden="true" className="size-[18px] shrink-0 text-fg-dim" />
                )}
                <span className={cn("text-body", ok ? "text-fg" : "text-fg-muted")}>{s.title}</span>
                <span className="text-sm text-fg-faint">{ok ? "Done" : "Left for later"}</span>
                {!ok && (
                  <Button variant="ghost" size="sm" className="ml-auto" onClick={() => step.goTo(s.id)}>
                    Go back
                  </Button>
                )}
              </m.li>
            );
          })}
        </ul>
        <p className="m-0 text-base leading-7 text-fg-muted">
          Start a task any time with <Kbd>N</Kbd>, and talk to the captain with <Kbd>{MOD_KEY} J</Kbd>.
        </p>
      </div>
    </StepFrame>
  );
}
