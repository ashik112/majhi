import type { OnboardingStatus, OnboardingStepId } from "@majhi/shared";
import { CircleAlert } from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** What every step can read and do, given by the journey around it. */
export interface JourneyApi {
  status: OnboardingStatus;
  /** This step is set up, as far as majhi can see. */
  done: boolean;
  isLast: boolean;
  /** On to the next stop. Leaving a step that is not done counts as skipping it. */
  next: () => void;
  /** Skip this step for now; it comes back from Hub setup. */
  skip: () => void;
  goTo: (id: OnboardingStepId) => void;
}

const JourneyContext = createContext<JourneyApi | null>(null);
export const JourneyProvider = JourneyContext.Provider;

export function useStep(): JourneyApi {
  const api = useContext(JourneyContext);
  if (!api) throw new Error("useStep needs the onboarding journey around it");
  return api;
}

/**
 * A step's body over its pinned footer. The body scrolls inside the panel; the footer keeps Skip
 * on the left and the one primary action on the right. While the step is not done the footer
 * offers Skip and the body holds the action; once it is done the footer's Continue takes over.
 */
export function StepFrame({
  children,
  primary,
  note,
  skippable = true,
}: {
  children: ReactNode;
  /** The footer's primary action. Default: Continue once the step is done. */
  primary?: ReactNode;
  /** A short line beside the actions, like what the primary button will do. */
  note?: ReactNode;
  skippable?: boolean;
}) {
  const step = useStep();
  const action =
    primary ??
    (step.done ? (
      <Button variant="primary" size="lg" onClick={step.next}>
        Continue
      </Button>
    ) : undefined);
  const skip = skippable && !step.done;
  return (
    <>
      <div className="-mx-1 flex min-h-0 flex-[0_1_auto] flex-col overflow-y-auto overscroll-contain px-1 pt-1 pb-6 scroll-fade">
        {children}
      </div>
      {(skip || note || action) && (
        <footer className="mt-2 flex min-h-[68px] shrink-0 items-center gap-3 border-t border-line pt-4 pb-5">
          {skip && (
            <Button variant="ghost" className="-ml-3" onClick={step.skip}>
              Skip for now
            </Button>
          )}
          {note && <p className="m-0 min-w-0 truncate text-sm text-fg-faint">{note}</p>}
          <div className="ml-auto flex items-center gap-2">{action}</div>
        </footer>
      )}
    </>
  );
}

/** A plain-sentence problem with what to do about it, for any call that failed. */
export function Problem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        "m-0 flex items-start gap-2 rounded-lg border border-red-line bg-red-wash px-3 py-2.5 text-base text-pretty text-red",
        className,
      )}
    >
      <CircleAlert aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A group heading inside a step: plain title weight, never an uppercase kicker. */
export function GroupTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-3">
      <h2 className="m-0 text-md font-semibold text-fg">{children}</h2>
      {aside && <div className="ml-auto flex items-center gap-2">{aside}</div>}
    </div>
  );
}
