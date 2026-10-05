/**
 * Self-hosted services (GitHub Enterprise, GitLab self-managed, Bitbucket Server). The owner types
 * a host, and majhi then sends a token to it. A host that points at majhi's own computer, the
 * owner's network or a cloud metadata address could turn that into a request the owner never meant
 * (SSRF), so such a host is refused unless the owner says it is on their own network.
 *
 * The checks here are pure. The server adds the DNS lookup (a public name can resolve to a private
 * address) in `connect/self-host.ts`.
 */

export type AddressClass =
  | "public"
  | "loopback"
  | "private"
  | "link-local"
  | "metadata"
  | "unspecified"
  | "reserved";

function v4(parts: readonly number[]): AddressClass {
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return parts[2] === 169 && parts[3] === 254 ? "metadata" : "link-local";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a >= 224) return "reserved";
  if (a === 192 && b === 0 && c === 0) return "reserved";
  if (a === 192 && b === 0 && c === 2) return "reserved";
  if (a === 198 && (b === 18 || b === 19)) return "reserved";
  if (a === 198 && b === 51 && c === 100) return "reserved";
  if (a === 203 && b === 0 && c === 113) return "reserved";
  return "public";
}

/** Dotted-quad parts of an IPv4 literal, or undefined. */
function parseV4(text: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
}

/** The 8 groups of an IPv6 literal, or undefined. Handles `::` and a trailing IPv4 part. */
function parseV6(text: string): number[] | undefined {
  let s = text.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(":")) return undefined;
  const tail = s.lastIndexOf(":");
  const dotted = parseV4(s.slice(tail + 1));
  if (s.slice(tail + 1).includes(".")) {
    if (dotted === undefined) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = dotted;
    s = `${s.slice(0, tail + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const group = (part: string) => (part === "" ? [] : part.split(":"));
  const head = group(halves[0] ?? "");
  const rest = halves.length === 2 ? group(halves[1] ?? "") : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const all = [...head, ...Array<string>(fill).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return all.map((g) => Number.parseInt(g, 16));
}

/** What an IP address literal is. `undefined` when the text is not an IP address. */
export function classifyAddress(text: string): AddressClass | undefined {
  const four = parseV4(text);
  if (four !== undefined) return v4(four);
  const six = parseV6(text);
  if (six === undefined) return undefined;
  const g = six;
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  // ::ffff:a.b.c.d is an IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return v4([(g[6] ?? 0) >> 8, (g[6] ?? 0) & 255, (g[7] ?? 0) >> 8, (g[7] ?? 0) & 255]);
  }
  const first = g[0] ?? 0;
  if (first === 0xfd00 && g[1] === 0x0ec2 && g[7] === 0x0254) return "metadata";
  if ((first & 0xfe00) === 0xfc00) return "private";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xff00) === 0xff00) return "reserved";
  return "public";
}

/** Names that are the owner's own computer or network, whatever they resolve to. */
function privateName(name: string): boolean {
  if (!name.includes(".")) return true;
  return [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"].some(
    (suffix) => name === suffix.slice(1) || name.endsWith(suffix),
  );
}

export interface HostIssue {
  /** `invalid`: not a host name. `blocked`: an address majhi refuses. */
  kind: "invalid" | "blocked";
  /** One sentence for the form. */
  message: string;
  /** The owner may allow it (it is on their own network). False for metadata addresses. */
  allowable: boolean;
}

/**
 * The host and port as WHATWG URL reads them: `2130706433` and `0x7f.1` both become `127.0.0.1`, so
 * the check sees the address a connection would use.
 */
export function canonicalHost(input: string): { hostname: string; port: string } | undefined {
  const text = input.trim().toLowerCase();
  if (text === "" || text.length > 255 || /[\s/\\@?#%]/.test(text)) return undefined;
  let hostname: string;
  let port = "";
  if (text.startsWith("[")) {
    const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(text);
    if (m === null) return undefined;
    hostname = m[1] ?? "";
    port = m[2] ?? "";
    return classifyAddress(hostname) === undefined ? undefined : { hostname, port };
  }
  const m = /^([a-z0-9]([a-z0-9._-]*[a-z0-9])?)(?::(\d{1,5}))?$/.exec(text);
  if (m === null) return undefined;
  hostname = m[1] ?? "";
  port = m[3] ?? "";
  if (port !== "" && Number(port) > 65535) return undefined;
  const dotted = inetAton(hostname);
  return { hostname: dotted ?? hostname, port };
}

/**
 * How a connection reads a name made of numbers (inet_aton): `2130706433`, `0x7f.1` and `0177.0.0.1`
 * all mean 127.0.0.1. Returns the dotted quad, or undefined when the text is a name.
 */
function inetAton(text: string): string | undefined {
  if (!/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/.test(text)) return undefined;
  const parts = text.split(".").map((p) => {
    if (p.startsWith("0x")) return Number.parseInt(p.slice(2), 16);
    if (p.length > 1 && p.startsWith("0")) return /^[0-7]+$/.test(p) ? Number.parseInt(p, 8) : Number.NaN;
    return Number.parseInt(p, 10);
  });
  if (parts.some((n) => !Number.isFinite(n))) return undefined;
  const last = parts[parts.length - 1] ?? 0;
  const head = parts.slice(0, -1);
  if (head.some((n) => n > 255) || last >= 256 ** (4 - head.length)) return undefined;
  const bytes = [...head];
  for (let i = 4 - head.length - 1; i >= 0; i--) bytes.push(Math.floor(last / 256 ** i) % 256);
  return bytes.join(".");
}

/**
 * Why a self-hosted host is refused, or undefined when it is fine. `allowPrivate` is the owner
 * saying "this server is on my own network": it lets private, loopback and reserved addresses
 * through. A cloud metadata address is never allowed.
 */
export function selfHostIssue(
  input: string,
  options: { allowPrivate?: boolean } = {},
): HostIssue | undefined {
  const parsed = canonicalHost(input);
  if (parsed === undefined) {
    return {
      kind: "invalid",
      message: "Use a host name like git.acme.test, without https:// or a path.",
      allowable: false,
    };
  }
  const { hostname } = parsed;
  const address = classifyAddress(hostname);
  if (address === "metadata" || address === "link-local" || address === "unspecified") {
    return {
      kind: "blocked",
      message: "That address is a cloud metadata or link-local address. majhi never sends a token there.",
      allowable: false,
    };
  }
  const own =
    address === undefined
      ? privateName(hostname)
      : address === "loopback" || address === "private" || address === "reserved";
  if (own && options.allowPrivate !== true) {
    return {
      kind: "blocked",
      message: `${hostname} is on this computer or a private network. Confirm that it is your own server to use it.`,
      allowable: true,
    };
  }
  return undefined;
}

/** True for a host that is not the service's own public one: a self-hosted server. */
export function isSelfHosted(host: string, publicHost: string): boolean {
  return host.trim().toLowerCase() !== publicHost;
}
