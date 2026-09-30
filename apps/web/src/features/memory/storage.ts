/** A value kept in this browser. Storage can be blocked or empty: then nothing is remembered. */
export function readStored(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}
