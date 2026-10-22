import { SETUP_STEPS, type SetupStepId } from "./steps";

/**
 * What the owner chose in this browser, kept in localStorage. Per-browser conveniences only: the server says what
 * is set up (`onboarding.status`); these say where the owner was and whether they put setup off. Storage can be
 * blocked, so every read falls back and every write may do nothing.
 *
 * - `majhi.onboarding.at`: the step the owner is on while setup is open, so a reload keeps their place.
 * - `majhi.setup.skipped` = "1": the owner chose "Finish later". The gate stops opening setup by itself; Home's
 *   "Add a project" and the palette still open it.
 */
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

/** The step setup was on before a reload, while it is still open. */
export function savedPlace(): SetupStepId | null {
  const at = read(AT);
  return SETUP_STEPS.find((id) => id === at) ?? null;
}

export function savePlace(id: SetupStepId | null): void {
  write(AT, id);
}

/** True when the owner chose "Finish later", so setup opens only when asked. */
export function setupSkipped(): boolean {
  return read(LATER) === "1";
}

/** Puts setup off: it stops opening by itself and forgets its place. */
export function finishLater(): void {
  write(LATER, "1");
  write(AT, null);
}

/** Setup is finished or the owner asked for it again: nothing is put off. */
export function endSetup(): void {
  write(AT, null);
  write(LATER, null);
}
