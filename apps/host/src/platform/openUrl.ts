/**
 * Opens an http(s) page in the owner's default browser with the first opener that works: `open` on
 * macOS, `xdg-open` on Linux, `wslview` (else `explorer.exe`) on WSL2. The URL is one argument,
 * never a shell string.
 */
import type { RunFn } from "../ssh.ts";

const OPEN_TIMEOUT_MS = 8_000;

export interface OpenUrlDeps {
  run: RunFn;
  /** The absolute path of an opener, or undefined when it is not there. */
  find: (name: string) => Promise<string | undefined>;
  /** `desktopEnv()`. */
  env: () => Promise<Record<string, string>>;
}

/** Opens `url`. False when it is not http(s), or no opener exists or worked. Never throws. */
export async function openUrl(deps: OpenUrlDeps, openers: readonly string[], url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  try {
    for (const name of openers) {
      const bin = await deps.find(name);
      if (bin === undefined) continue;
      const run = await deps.run(bin, [parsed.toString()], {
        env: await deps.env(),
        timeoutMs: OPEN_TIMEOUT_MS,
      });
      // explorer.exe answers 1 even when it opened the page.
      if (run.code === 0 || (name === "explorer.exe" && run.code === 1)) return true;
    }
  } catch {
    // A lookup failed. Nothing opened the page.
  }
  return false;
}
