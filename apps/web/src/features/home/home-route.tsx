import { useState } from "react";
import { ReposScreen } from "@/features/repos/repos-screen";
import { ReposSkeleton } from "@/features/repos/repos-skeleton";
import { useConfig } from "@/lib/queries";
import { OnboardingFlow } from "@/onboarding/onboarding-flow";
import { ConfigError } from "./config-error";
import { ServerError } from "./server-error";

/** `/` picks the screen from the config state: onboarding on first run, a broken config, or the repos. */
export function HomeRoute() {
  const config = useConfig();
  const state = config.data;
  // Onboarding starts on first run and stays until its last step finishes, although the config
  // stops being first-run as soon as the roots step saves.
  const [onboarding, setOnboarding] = useState(false);

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
    return <ReposSkeleton />;
  }

  if (state.status === "first-run" || onboarding) {
    if (!onboarding) setOnboarding(true);
    return <OnboardingFlow onFinish={() => setOnboarding(false)} />;
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

  return <ReposScreen home={state.home} />;
}
