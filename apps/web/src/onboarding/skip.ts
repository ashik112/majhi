const KEY = "majhi.setup.skipped";

/** Whether the owner chose to skip the account and captain steps. A per-browser convenience only. */
export function setupSkipped(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function skipSetup(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Storage can be blocked; the choice then lasts until the page reloads.
  }
}
