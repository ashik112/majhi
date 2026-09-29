import { useSyncExternalStore } from "react";
import type { SetupStepId } from "./model";

/**
 * A page asks the app gate to show onboarding again, from a given step (Hub setup does). The gate
 * owns the screen, so this is a one-slot mailbox it reads and clears.
 */
export interface OnboardingRequest {
  step: SetupStepId;
  /** Changes on every request, so asking twice for the same step still counts. */
  id: number;
}

let current: OnboardingRequest | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function reopenOnboarding(step: SetupStepId = "roots"): void {
  counter += 1;
  current = { step, id: counter };
  emit();
}

export function clearOnboardingRequest(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function useOnboardingRequest(): OnboardingRequest | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
