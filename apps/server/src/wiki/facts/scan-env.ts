import { endpointId, isLoopbackHost } from "../system/address.ts";
import { kebab, type ScanContext } from "./context.ts";
import { splitSpaces } from "./formats.ts";
import { keyIsNotACall, outsideOfHost, storeOfScheme } from "./known.ts";
import type { Cite } from "./sink.ts";
import { addStore } from "./stores.ts";

/**
 * Environment values that point at another service: a connection URL to a datastore, or the address of something
 * the repo calls. Shared by `.env.example`, compose `environment` and Kubernetes `env`, which all hold the same
 * kind of value. Only the name of the setting leaves this module: a value never becomes part of a fact.
 */

export interface ValueRef {
  key: string;
  value: string;
  /** Where the setting is written. */
  cite: Cite;
  /** The folder or unit the setting belongs to: where a role found in it is shown. */
  where: string;
  /** The compose service the setting is in, when it is one: a URL naming another service is a link between them. */
  unit?: string;
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

/**
 * Reads one environment value. A datastore connection URL is a use of that store. A web URL is an address the repo
 * calls: a known outside service is a role, a compose service of this repo is a link between two units, any other
 * becomes an endpoint that needs an owner. Lists of origins, CORS settings, the repo's own addresses and names
 * with no URL are never calls.
 */
export function fromValue(ctx: ScanContext, ref: ValueRef): void {
  const { sink } = ctx;
  const { key, value, cite } = ref;
  if (value === "" || isList(value.trim())) return;
  const url = parseUrl(value.trim());
  if (url === undefined) return;
  const host = url.hostname.toLowerCase();
  const service = ctx.service(host);
  const link = (type: "http" | "queue" | "data") => {
    if (ref.unit === undefined || service === undefined || host === ref.unit) return;
    sink.add({
      kind: "link",
      from: sink.idOf("unit", ref.unit),
      to: sink.idOf("unit", host),
      type,
      basis: "config",
      slug: `${kebab(ref.unit)}-${type}-${kebab(host)}`,
      cites: [cite],
    });
  };

  const store = storeOfScheme(url.protocol.slice(0, -1));
  if (store !== undefined) {
    const unit = service?.store?.slug === store.slug ? host : undefined;
    addStore(ctx, { store, unit, basis: "config", cite, where: ref.where });
    link(store.kind === "queue" ? "queue" : "data");
    return;
  }
  if (!WEB_SCHEMES.has(url.protocol) || keyIsNotACall(key)) return;
  const outside = outsideOfHost(host);
  if (outside !== undefined) {
    sink.add({
      kind: "role",
      role: "outside",
      where: ref.where,
      tech: outside.label,
      basis: "config",
      slug: `outside-${kebab(outside.label)}-${kebab(ref.where)}`,
      cites: [cite],
    });
    return;
  }
  if (service !== undefined) {
    link("http");
    return;
  }
  const local = isLoopbackHost(host);
  // A local address with no port says nothing about where it leads.
  if (local && url.port === "") return;
  const port = url.port === "" ? undefined : Number(url.port);
  const scope = local ? sink.repo : undefined;
  sink.add({
    kind: "endpoint",
    host,
    ...(port === undefined ? {} : { port }),
    ...(scope === undefined ? {} : { scope }),
    keys: [key.slice(0, 120)],
    basis: "config",
    slug: endpointId(host, port, scope),
    cites: [cite],
  });
}

/** The settings of `.env.example` and its siblings. */
export function scanDotenv(ctx: ScanContext): void {
  for (const file of ctx.scan.dotenv) {
    const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
    for (const entry of file.entries) {
      fromValue(ctx, {
        key: entry.key,
        value: entry.value,
        cite: { path: file.path, lines: [entry.line, entry.line] },
        where: dir === "" ? "." : dir,
      });
    }
  }
}
