/**
 * Addresses a repo's files call. A host and port found in a URL is an `endpoint` fact; a local address means
 * "this computer", which is a different thing in every repo that writes it, so it carries that repo as its scope.
 */

/** Hosts that mean "this computer": the same name is a different thing in every project that writes it. */
const LOOPBACK: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "host.docker.internal",
]);
export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host.toLowerCase());

/** `host`, `host:port`, or `<scope>@host:port` for an address that only means something inside one repo. */
export function endpointId(host: string, port: number | undefined, scope: string | undefined): string {
  const address = `${host.toLowerCase()}${port === undefined ? "" : `:${port}`}`;
  return scope === undefined ? address : `${scope}@${address}`;
}

/** `host` or `host:port` as typed, parsed with the URL parser. Undefined when it is anything else. */
export function parseAddress(text: string): { host: string; port: number | undefined } | undefined {
  let url: URL;
  try {
    url = new URL(`http://${text.trim()}`);
  } catch {
    return undefined;
  }
  const clean = url.pathname === "/" && url.search === "" && url.hash === "" && url.username === "";
  if (!clean || url.hostname === "") return undefined;
  return { host: url.hostname.toLowerCase(), port: url.port === "" ? undefined : Number(url.port) };
}
