import { ONBOARDING_STEP_IDS, type OnboardingStepId, OnboardingStepIdSchema } from "@majhi/shared";

/**
 * What the owner chose in this browser, kept in localStorage. Per-browser conveniences only: the
 * server says what is set up (`onboarding.status`); these say what the owner put off and where
 * they were. Storage can be blocked, so every read falls back and every write may do nothing.
 *
 * - `majhi.onboarding.skipped`: the step ids the owner skipped, as a JSON array.
 * - `majhi.onboarding.at`: the step the owner is on while the journey is open, so a reload keeps
 *   their place. Cleared when the journey ends or is put off.
 * - `majhi.setup.skipped` = "1": the owner chose "Finish later". The gate stops opening the
 *   journey by itself; Hub setup still reopens any step. The key predates the step list.
 */
const SKIPPED = "majhi.onboarding.skipped";
const AT = "majhi.onboarding.at";
const LATER = "majhi.setup.skipped";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Blocked storage: the choice lasts until the page reloads.
  }
}

export function skippedSteps(): ReadonlySet<OnboardingStepId> {
  const raw = read(SKIPPED);
  if (raw === null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const ids = new Set<OnboardingStepId>();
    for (const value of parsed) {
      const id = OnboardingStepIdSchema.safeParse(value);
      if (id.success) ids.add(id.data);
    }
    return ids;
  } catch {
    return new Set();
  }
}

function saveSkipped(ids: ReadonlySet<OnboardingStepId>): void {
  write(SKIPPED, JSON.stringify(ONBOARDING_STEP_IDS.filter((id) => ids.has(id))));
}

export function skipStep(id: OnboardingStepId): void {
  saveSkipped(new Set([...skippedSteps(), id]));
}

export function unskipStep(id: OnboardingStepId): void {
  const ids = new Set(skippedSteps());
  ids.delete(id);
  saveSkipped(ids);
}

/** The step the journey was on before a reload, while it is still open. */
export function savedPlace(): OnboardingStepId | null {
  const parsed = OnboardingStepIdSchema.safeParse(read(AT));
  return parsed.success ? parsed.data : null;
}

export function savePlace(id: OnboardingStepId | null): void {
  write(AT, id);
}

/** True when the owner chose "Finish later", so the journey opens only when asked. */
export function setupSkipped(): boolean {
  return read(LATER) === "1";
}

/** Puts the whole journey off: it stops opening by itself and forgets its place. */
export function finishLater(): void {
  write(LATER, "1");
  write(AT, null);
}

/** The journey ended at Arrive: nothing left to resume. */
export function endJourney(): void {
  write(AT, null);
}
