import { useState } from "react";
import { TasksScreen } from "@/features/tasks/tasks-screen";
import { useConfig } from "@/lib/queries";
import { useAccounts, useAgents } from "@/lib/studio-queries";
import { firstIncompleteStep, type SetupStepId } from "@/onboarding/model";
import { OnboardingFlow } from "@/onboarding/onboarding-flow";
import { setupSkipped, skipSetup } from "@/onboarding/skip";
import { onboardingSteps } from "@/onboarding/steps";
import { ConfigError } from "./config-error";
import { HomeLoading } from "./home-loading";
import { ServerError } from "./server-error";

/** `/` and `/t/<id>` pick the screen from the config state: onboarding on first run, a broken config, or the tasks. */
export function HomeRoute({ taskId }: { taskId?: string | undefined }) {
  const config = useConfig();
  const state = config.data;
  // Onboarding starts on first run and stays until its last step finishes, although the config
  // stops being first-run as soon as the roots step saves.
  const [onboarding, setOnboarding] = useState(false);
  const [startId, setStartId] = useState<SetupStepId>("roots");
  const [skipped, setSkipped] = useState(setupSkipped);
  // After the roots are set the server state says what is left: an account, then a boss.
  const loaded = state?.status === "loaded";
  const accounts = useAccounts(loaded);
  const agents = useAgents(loaded);

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
    return <HomeLoading />;
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
    // Wait for the server state, so a reload resumes at the right step instead of flashing the repos.
    if (accounts.isPending || agents.isPending) return <HomeLoading />;
    if (accounts.data && agents.data) {
      const next = firstIncompleteStep({ noRoots: false, accounts: accounts.data, agents: agents.data });
      if (next) {
        setStartId(next);
        setOnboarding(true);
        return null;
      }
    }
  }

  return <TasksScreen taskId={taskId} />;
}
