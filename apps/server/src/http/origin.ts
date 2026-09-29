const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** True for pages served from this machine. Used for commands, uploads and WebSockets. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
