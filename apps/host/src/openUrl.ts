/**
 * Opens an http(s) page in the owner's default browser: `open` on macOS, `xdg-open` on Linux,
 * `wslview` (else `explorer.exe`) on WSL. The URL is one argument, never a shell string.
 */
import type { RunFn } from "./ssh.ts";

const OPEN_TIMEOUT_MS = 8_000;

export interface OpenUrlDeps {
  run: RunFn;
  platform: NodeJS.Platform;
  /** True on Windows Subsystem for Linux. */
  wsl: boolean;
  path: string;
  /** The helper's environment. Only what a desktop opener needs is passed on. */
  env: Readonly<Record<string, string | undefined>>;
  find: (name: string) => Promise<string | undefined>;
}

const DESKTOP_VARS = [
  "HOME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "BROWSER",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
];

/** The programs to try, in order. */
export function openers(platform: NodeJS.Platform, wsl: boolean): string[] {
  if (platform === "darwin") return ["open"];
  if (wsl) return ["wslview", "explorer.exe"];
  return ["xdg-open"];
}

/** Opens `url`. False when it is not http(s), or no opener exists or worked. Never throws. */
export async function openUrl(deps: OpenUrlDeps, url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  for (const name of openers(deps.platform, deps.wsl)) {
    const bin = await deps.find(name);
    if (bin === undefined) continue;
    const env: Record<string, string> = { PATH: deps.path };
    for (const key of DESKTOP_VARS) {
      const value = deps.env[key];
      if (value !== undefined && value !== "") env[key] = value;
    }
    const run = await deps.run(bin, [parsed.toString()], { env, timeoutMs: OPEN_TIMEOUT_MS });
    // explorer.exe answers 1 even when it opened the page.
    if (run.code === 0 || (name === "explorer.exe" && run.code === 1)) return true;
  }
  return false;
}
