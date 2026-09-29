import type { WorkspacesUpdateResult } from "@majhi/shared";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { RestartCard } from "@/features/roots/restart-card";
import { RootsForm } from "@/features/roots/roots-form";
import { useConfig } from "@/lib/queries";
import type { OnboardingStepProps } from "./steps";

/** Step 1: pick workspace roots. Roots majhi cannot see yet get the restart card before moving on. */
export function RootsStep({ isLast, onComplete }: OnboardingStepProps) {
  const config = useConfig();
  const toast = useToast();
  const [restart, setRestart] = useState<WorkspacesUpdateResult | null>(null);
  const state = config.data;

  if (restart) {
    return (
      <RestartCard
        result={restart}
        home={restart.state.home}
        continueLabel={isLast ? "Show repos now" : "Continue"}
        onContinue={onComplete}
      />
    );
  }

  // The shell only runs while the config has loaded; this guards the type, not a real state.
  if (!state) return null;

  return (
    <RootsForm
      mode="first-run"
      home={state.home}
      file={state.file}
      initial={{ rows: [], tasksDir: "" }}
      onSaved={(result) => {
        if (result.unmounted.length > 0) {
          setRestart(result);
          return;
        }
        toast("Roots saved");
        onComplete();
      }}
    />
  );
}
