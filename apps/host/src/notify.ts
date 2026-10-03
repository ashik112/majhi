import type { Notifier } from "./platform/types.ts";

export interface NotifyParams {
  title: string;
  message: string;
  path?: string | undefined;
  sound: boolean;
}

/** The page a click opens: majhi's address and a path. Anything but a plain path gives nothing. */
export function clickUrl(baseUrl: string, path: string | undefined): string | undefined {
  if (path === undefined || !/^\/(?!\/)/.test(path)) return undefined;
  const url = new URL(path, `${baseUrl}/`);
  return url.origin === new URL(baseUrl).origin ? url.href : undefined;
}

/** Text that is safe in any notifier: no control characters, one line, a bounded length. */
export function plainLine(text: string, max = 300): string {
  let flat = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    flat += code < 32 || code === 127 || code === 0x2028 || code === 0x2029 ? " " : ch;
  }
  flat = flat.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Shows a notification through the OS's notifier, as plain lines, with a click that can open only a
 * majhi page. `baseUrl` is majhi's address, like http://127.0.0.1:7070.
 */
export function showNotification(
  notifier: Notifier,
  baseUrl: string,
  params: NotifyParams,
): Promise<{ clickable: boolean }> {
  return notifier.show({
    title: plainLine(params.title, 120),
    message: plainLine(params.message),
    url: clickUrl(baseUrl, params.path),
    sound: params.sound,
  });
}
