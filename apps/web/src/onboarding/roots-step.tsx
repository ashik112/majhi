import type { WorkspacesUpdateResult } from "@majhi/shared";
import { useState } from "react";
import { useToast } from "@/components/ui/toast";
import { draftFromConfig } from "@/features/roots/model";
import { RestartCard } from "@/features/roots/restart-card";
import { RestartingCard } from "@/features/roots/restarting-card";
import { RootsForm } from "@/features/roots/roots-form";
import { useConfig } from "@/lib/queries";
import type { OnboardingStepProps } from "./steps";

/**
 * Step 1: pick workspace roots. Roots majhi cannot see yet are mounted by the host helper, which
 * restarts majhi, or need a manual restart when no helper is connected.
 */
export function RootsStep({ isLast, onComplete }: OnboardingStepProps) {
  const config = useConfig();
  const toast = useToast();
  const [pending, setPending] = useState<WorkspacesUpdateResult | null>(null);
  const state = config.data;
  const continueLabel = isLast ? "Show repos now" : "Continue";

  if (pending?.remount === "restarting") {
    return (
      <RestartingCard
        roots={pending.unmounted}
        home={pending.state.home}
        continueLabel={continueLabel}
        onBack={() => {
          toast("Roots mounted");
          onComplete();
        }}
        onContinue={onComplete}
      />
    );
  }

  if (pending) {
    return (
      <RestartCard
        result={pending}
        home={pending.state.home}
        continueLabel={continueLabel}
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
      initial={
        state.status === "loaded" ? draftFromConfig(state.config, state.home) : { rows: [], tasksDir: "" }
      }
      onSaved={(result) => {
        if (result.remount !== "not-needed") {
          setPending(result);
          return;
        }
        toast("Roots saved");
        onComplete();
      }}
    />
  );
}
