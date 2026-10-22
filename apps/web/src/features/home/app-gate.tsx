import { useNavigate, useRouterState } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/lib/queries";
import { setupOpen } from "@/onboarding/model";
import { clearOnboardingRequest, useOnboardingRequest } from "@/onboarding/reopen";
import { endSetup, finishLater, savedPlace, setupSkipped } from "@/onboarding/skip";
import type { SetupStepId } from "@/onboarding/steps";
import { useJourney } from "@/onboarding/use-journey";
import { ConfigError } from "./config-error";
import { ServerError } from "./server-error";

const SetupFlow = lazy(() =>
  import("@/onboarding/setup-flow").then((module) => ({ default: module.SetupFlow })),
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
 * Decides what the whole window shows from the config state: setup on first run, a broken config, or the app
 * (children). Setup also opens while no account can run agents or no captain is set, comes back after a reload at
 * the step it was on, and opens when the palette asks for it. "Finish later" puts it off; Home's "Add a
 * project" still opens its second step as a dialog. The folder settings page stays reachable in every state.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const config = useConfig();
  const state = config.data;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  // The step setup is open at, or null for the app. A reload resumes where it was.
  const [open, setOpen] = useState<SetupStepId | null>(savedPlace);
  const [session, setSession] = useState(0);
  const [later, setLater] = useState(setupSkipped);
  const appShown = useRef(false);
  const journey = useJourney();
  // The palette can ask for setup again. The request is taken once.
  const reopen = useOnboardingRequest();
  useEffect(() => {
    if (!reopen) return;
    setOpen(reopen.step);
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
        <SetupFlow
          key={session}
          start={open ?? "signin"}
          onLater={() => {
            finishLater();
            setLater(true);
            setOpen(null);
          }}
          onArrive={(task) => {
            endSetup();
            setLater(false);
            setOpen(null);
            if (task !== undefined) void navigate({ to: "/t/$taskId", params: { taskId: task } });
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
    // Wait for the status, so a reload resumes at the right step instead of flashing Home.
    // Once the app shows it stays: a status refetch never swaps it for a loading screen.
    if (!journey.status) return <AppLoading />;
    if (setupOpen(journey.status)) {
      setOpen("signin");
      return null;
    }
  }

  appShown.current = true;
  return children;
}
