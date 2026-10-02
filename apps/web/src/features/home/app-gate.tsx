import { useRouterState } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfig } from "@/lib/queries";
import { useAccounts, useAgents } from "@/lib/studio-queries";
import { firstIncompleteStep, type SetupStepId } from "@/onboarding/model";
import { OnboardingFlow } from "@/onboarding/onboarding-flow";
import { clearOnboardingRequest, useOnboardingRequest } from "@/onboarding/reopen";
import { setupSkipped, skipSetup } from "@/onboarding/skip";
import { onboardingSteps } from "@/onboarding/steps";
import { ConfigError } from "./config-error";
import { ServerError } from "./server-error";

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
 * Decides what the whole window shows from the config state: onboarding on first run, a broken
 * config, or the app (children). The roots settings page stays reachable in every state.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const config = useConfig();
  const state = config.data;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Onboarding starts on first run and stays until its last step finishes, although the config
  // stops being first-run as soon as the roots step saves.
  const [onboarding, setOnboarding] = useState(false);
  const [startId, setStartId] = useState<SetupStepId>("roots");
  const [skipped, setSkipped] = useState(setupSkipped);
  // Hub setup can ask for onboarding again. The request is taken once.
  const reopen = useOnboardingRequest();
  useEffect(() => {
    if (!reopen) return;
    setStartId(reopen.step);
    setOnboarding(true);
    clearOnboardingRequest();
  }, [reopen]);
  // After the roots are set the server state says what is left: an account, then a captain.
  const loaded = state?.status === "loaded";
  const accounts = useAccounts(loaded);
  const agents = useAgents(loaded);

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

  if (state.status === "first-run" || onboarding) {
    if (!onboarding) setOnboarding(true);
    return (
      <OnboardingFlow
        startIndex={Math.max(
          0,
          onboardingSteps.findIndex((s) => s.id === startId),
        )}
        onFinish={() => {
          setSkipped(true);
          setOnboarding(false);
        }}
        onSkip={() => {
          skipSetup();
          setSkipped(true);
          setOnboarding(false);
        }}
      />
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

  if (!skipped) {
    // Wait for the server state, so a reload resumes at the right step instead of flashing the board.
    if (accounts.isPending || agents.isPending) return <AppLoading />;
    if (accounts.data && agents.data) {
      const next = firstIncompleteStep({ noRoots: false, accounts: accounts.data, agents: agents.data });
      if (next) {
        setStartId(next);
        setOnboarding(true);
        return null;
      }
    }
  }

  return children;
}
