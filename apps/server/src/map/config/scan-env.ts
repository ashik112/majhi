import type { MapBuilder, Proof } from "./builder.ts";
import type { Loaded } from "./facts.ts";
import { outsideOfHost, outsideOfKey, storeOfScheme } from "./known.ts";
import type { Resolver } from "./resolver.ts";

/**
 * Environment values that point at another service: a connection URL to a datastore, an address of another
 * project, a service's API host, or a variable named for a service. Shared by `.env.example`, compose
 * `environment` and Kubernetes `env`, which all hold the same kind of value.
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

/**
 * Turns one environment value into a line from `from`. `self` is the project the value belongs to, so a
 * project never points at itself.
 */
export function linkFromValue(
  ctx: { resolver: Resolver; b: MapBuilder; self: string },
  from: string,
  key: string,
  value: string,
  proof: Proof,
): void {
  const { resolver, b, self } = ctx;
  const url = parseUrl(value);
  if (url === undefined) {
    const service = value === "" ? undefined : outsideOfKey(key);
    if (service !== undefined) {
      b.outside(service);
      b.edge({ from, to: `outside:${service.slug}`, type: "http", label: "API", proof });
    }
    return;
  }
  const scheme = url.protocol.slice(0, -1);
  const store = storeOfScheme(scheme);
  if (store !== undefined) {
    b.store(store);
    const database = url.pathname.length > 1 ? url.pathname.slice(1) : "";
    b.edge({
      from,
      to: `store:${store.slug}`,
      type: store.kind === "queue" ? "queue" : "data",
      label:
        store.kind === "queue"
          ? "jobs"
          : store.kind === "cache"
            ? "cache"
            : database === ""
              ? "data"
              : database,
      proof,
    });
    return;
  }
  if (!WEB_SCHEMES.has(url.protocol)) return;
  const outside = outsideOfHost(url.hostname);
  if (outside !== undefined) {
    b.outside(outside);
    b.edge({ from, to: `outside:${outside.slug}`, type: "http", label: "API", proof });
    return;
  }
  const target = resolver.byUrl(url, key, self);
  if (target === undefined) return;
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  b.edge({
    from,
    to: target.id,
    type: "http",
    label: path === "" ? "HTTP" : `HTTP ${path}`,
    proof,
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
