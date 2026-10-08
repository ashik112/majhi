import { type OnboardingStepId, onboardingStepId } from "@majhi/shared";
import { useRouterState } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/lib/queries";
import { openNewTaskOnArrival } from "@/onboarding/arrive";
import { gateStep } from "@/onboarding/model";
import { clearOnboardingRequest, useOnboardingRequest } from "@/onboarding/reopen";
import {
  endJourney,
  finishLater,
  savedPlace,
  setupSkipped,
  skippedSteps,
  unskipStep,
} from "@/onboarding/skip";
import { useJourney } from "@/onboarding/use-journey";
import { ConfigError } from "./config-error";
import { ServerError } from "./server-error";

const OnboardingFlow = lazy(() =>
  import("@/onboarding/onboarding-flow").then((module) => ({ default: module.OnboardingFlow })),
);

/** Stands in for the whole app while the config loads: a sidebar and a board of blocks. */
function AppLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex min-h-0 flex-1">
      <span className="sr-only">Loading</span>
      <div className="flex w-60 shrink-0 flex-col gap-3 border-r border-line-strong bg-rail p-3.5">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
      <div className="flex flex-1 flex-col gap-4 p-8">
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-5 gap-4">
          {["a", "b", "c", "d", "e"].map((k) => (
            <Skeleton key={k} className="h-32 rounded-lg" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Decides what the whole window shows from the config state: the onboarding journey on first run,
 * a broken config, or the app (children). The journey also opens while an essential step (the
 * folder, an AI account, the captain) is neither done nor skipped, comes back after a reload at
 * the step it was on, and opens at any step Hub setup asks for. The roots settings page stays
 * reachable in every state.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const config = useConfig();
  const state = config.data;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The step the journey is open at, or null for the app. A reload resumes where it was.
  const [open, setOpen] = useState<OnboardingStepId | null>(savedPlace);
  const [session, setSession] = useState(0);
  const [later, setLater] = useState(setupSkipped);
  const appShown = useRef(false);
  const journey = useJourney();
  // Hub setup can ask for the journey again. The request is taken once.
  const reopen = useOnboardingRequest();
  useEffect(() => {
    if (!reopen) return;
    const id = onboardingStepId(reopen.step);
    unskipStep(id);
    setOpen(id);
    setSession((n) => n + 1);
    clearOnboardingRequest();
  }, [reopen]);

  if (pathname === "/settings/roots") return children;

  if (!state) {
    if (config.isError) {
      return (
        <ServerError
          error={config.error}
          onRetry={() => void config.refetch()}
          retrying={config.isFetching}
        />
      );
    }
    return <AppLoading />;
  }

  if (state.status === "first-run" || open) {
    return (
      <Suspense fallback={<AppLoading />}>
        <OnboardingFlow
          key={session}
          start={state.status === "first-run" ? "welcome" : (open ?? "welcome")}
          onLater={() => {
            finishLater();
            setLater(true);
            setOpen(null);
          }}
          onArrive={() => {
            endJourney();
            openNewTaskOnArrival();
            setOpen(null);
          }}
        />
      </Suspense>
    );
  }

  if (state.status === "invalid") {
    return (
      <ConfigError
        file={state.file}
        home={state.home}
        errors={state.errors}
        onRetry={() => void config.refetch()}
        retrying={config.isFetching}
      />
    );
  }

  if (!later && !appShown.current) {
    // Wait for the status, so a reload resumes at the right step instead of flashing the board.
    // Once the app shows it stays: a status refetch never swaps it for a loading screen.
    if (!journey.status) return <AppLoading />;
    const step = gateStep(journey.status, skippedSteps());
    if (step) {
      setOpen(step);
      return null;
    }
  }

  appShown.current = true;
  return children;
}
