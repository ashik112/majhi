import { isLoopbackHost } from "@majhi/shared";
import type { MapBuilder, Proof } from "./builder.ts";
import type { Loaded } from "./facts.ts";
import { splitSpaces } from "./formats.ts";
import { keyIsNotACall, outsideOfHost, storeOfScheme } from "./known.ts";
import type { Resolver } from "./resolver.ts";

/**
 * Environment values that point at another service: a connection URL to a datastore, or the address of
 * something the project calls. Shared by `.env.example`, compose `environment` and Kubernetes `env`, which
 * all hold the same kind of value.
 */

/** A URL as text, without the user and password. */
function plainUrl(u: URL): string {
  const copy = new URL(u.href);
  copy.username = "";
  copy.password = "";
  return copy.href;
}

/** The excerpt of an environment line: a URL without credentials, any other value hidden. */
export function envExcerpt(key: string, value: string): string {
  const url = parseUrl(value);
  return url === undefined ? `${key}=…` : `${key}=${plainUrl(url)}`;
}

function parseUrl(value: string): URL | undefined {
  try {
    const u = new URL(value);
    // `localhost:8000` parses as a scheme named localhost: a URL needs two slashes after it.
    return value.includes("://") ? u : undefined;
  } catch {
    return undefined;
  }
}

const WEB_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "ws:", "wss:"]);

/** A value that holds several addresses (commas or spaces between them) is a setting, never one call. */
function isList(value: string): boolean {
  return value.includes(",") || splitSpaces(value).length > 1;
}

/** The remote host of a connection URL that two projects could share. A local or one-word name is each project's own. */
function sharedAddress(url: URL): { host: string; port: number | undefined; db: string } | undefined {
  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host) || !host.includes(".") || host.includes(":")) return undefined;
  const db = url.pathname.length > 1 ? url.pathname.slice(1) : "";
  return { host, port: url.port === "" ? undefined : Number(url.port), db };
}

/**
 * Reads one environment value of a project. A datastore connection URL is a use of that store (a chip, or a
 * shared box when another project names the same remote host and database). A web URL is an address the
 * project calls: a known outside service becomes a chip; any other becomes an endpoint that needs an owner.
 * Lists of origins, CORS settings, the project's own addresses and names with no URL are never calls.
 */
export function linkFromValue(
  ctx: { resolver: Resolver; b: MapBuilder; self: string },
  from: string,
  key: string,
  value: string,
  proof: Proof,
): void {
  const { resolver, b } = ctx;
  if (value === "" || isList(value.trim())) return;
  const url = parseUrl(value.trim());
  if (url === undefined) return;
  const store = storeOfScheme(url.protocol.slice(0, -1));
  if (store !== undefined) {
    const address = sharedAddress(url);
    b.storeRef({
      project: from,
      store,
      via: store.kind === "queue" ? "queue" : "data",
      proof,
      ...(address === undefined ? {} : { address }),
    });
    return;
  }
  if (!WEB_SCHEMES.has(url.protocol) || keyIsNotACall(key)) return;
  const host = url.hostname.toLowerCase();
  const outside = outsideOfHost(host);
  if (outside !== undefined) {
    b.chip(from, "uses", outside.label);
    return;
  }
  const local = isLoopbackHost(host);
  // A local address with no port says nothing about where it leads.
  if (local && url.port === "") return;
  const known = local ? undefined : resolver.ownerOfService(host);
  if (known === from) return;
  b.endpoint({
    host,
    port: url.port === "" ? undefined : Number(url.port),
    from,
    key,
    proof,
    known,
  });
}

/** The lines of `.env.example` and its siblings. */
export function scanDotenv(loaded: Loaded, ctx: { resolver: Resolver; b: MapBuilder }): void {
  const self = loaded.facts.id;
  for (const file of loaded.dotenv) {
    for (const entry of file.entries) {
      linkFromValue({ ...ctx, self }, self, entry.key, entry.value, {
        project: self,
        file: file.file,
        line: entry.line,
        excerpt: envExcerpt(entry.key, entry.value),
      });
    }
  }
}
