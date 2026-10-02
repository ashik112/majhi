import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/status-dot";
import { reopenOnboarding } from "./reopen";
import { skippedSteps } from "./skip";
import { onboardingSteps } from "./steps";
import { useJourney } from "./use-journey";

/**
 * Hub setup's list of the journey's steps: what is done, and Open on the rest. Open brings the
 * journey back at that step and clears its skip.
 */
export function SetupJourneyList() {
  const status = useJourney().status;
  const skipped = skippedSteps();
  const done = new Set(status?.steps.filter((s) => s.done).map((s) => s.id) ?? []);
  const steps = onboardingSteps.filter((s) => s.id !== "finish");
  return (
    <ul aria-label="First-time setup steps" className="m-0 flex max-w-[640px] list-none flex-col p-0">
      {steps.map((s) => {
        const ok = done.has(s.id);
        return (
          <li key={s.id} className="flex min-h-11 items-center gap-3 border-t border-line first:border-t-0">
            <Dot tone={ok ? "green" : "neutral"} size={7} />
            <span className="text-base font-medium text-fg">{s.title}</span>
            <span className="text-sm text-fg-faint">
              {ok ? "Done" : skipped.has(s.id) ? "Skipped" : "Not done"}
            </span>
            <Button
              size="sm"
              variant={ok ? "ghost" : "secondary"}
              className="ml-auto"
              onClick={() => reopenOnboarding(s.id)}
            >
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
