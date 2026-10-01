import type { RunFn } from "./ssh.ts";
import { notificationScript, plainLine } from "./startup.ts";

export interface NotifyParams {
  title: string;
  message: string;
  path?: string | undefined;
  sound: boolean;
}

export interface NotifyDeps {
  run: RunFn;
  env: Record<string, string>;
  /** `terminal-notifier`, when installed: the only way a click can open a page. */
  terminalNotifier: string | undefined;
  /** majhi's address, like http://127.0.0.1:7070. */
  baseUrl: string;
}

const OSASCRIPT = "/usr/bin/osascript";
const NOTIFY_TIMEOUT_MS = 10_000;

/** The page a click opens: majhi's address and a path. Anything but a plain path gives nothing. */
export function clickUrl(baseUrl: string, path: string | undefined): string | undefined {
  if (path === undefined || !/^\/(?!\/)/.test(path)) return undefined;
  const url = new URL(path, `${baseUrl}/`);
  return url.origin === new URL(baseUrl).origin ? url.href : undefined;
}

/**
 * Shows a notification. With `terminal-notifier` a click opens majhi at the page; `osascript` cannot
 * carry a click, so without it the notification shows and a click does nothing.
 */
export async function showNotification(
  deps: NotifyDeps,
  params: NotifyParams,
): Promise<{ clickable: boolean }> {
  const url = clickUrl(deps.baseUrl, params.path);
  const title = plainLine(params.title, 120);
  const message = plainLine(params.message);
  if (deps.terminalNotifier !== undefined && url !== undefined) {
    const args = ["-title", title, "-message", message, "-open", url, "-group", "majhi"];
    if (params.sound) args.push("-sound", "Glass");
    const done = await deps.run(deps.terminalNotifier, args, { env: deps.env, timeoutMs: NOTIFY_TIMEOUT_MS });
    if (done.code === 0) return { clickable: true };
  }
  const done = await deps.run(
    OSASCRIPT,
    ["-e", notificationScript(message, { title, sound: params.sound })],
    { env: deps.env, timeoutMs: NOTIFY_TIMEOUT_MS },
  );
  if (done.code !== 0)
    throw new Error("macOS did not show the notification. Check System Settings, Notifications.");
  return { clickable: false };
}
