import { DEFAULT_MAJHI_ORIGIN } from "@majhi/shared";

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** True for pages served from this machine. Used for commands, uploads and WebSockets. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Browser access is tied to one configured scheme, host and port. */
export function isOwnerOrigin(origin: string, configured = DEFAULT_MAJHI_ORIGIN): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === new URL(configured).origin
    );
  } catch {
    return false;
  }
}
