import { lookup as dnsLookup } from "node:dns/promises";
import { classifyAddress, selfHostIssue } from "@majhi/shared";
import { errorCode, UserError } from "../errors.ts";

/**
 * Where majhi may send a token to a self-hosted service. The owner types the host (GitHub
 * Enterprise, GitLab self-managed, Bitbucket Server, an MCP server by URL). A host that is, or
 * resolves to, this computer, the owner's network or a metadata address would make majhi call
 * something the owner never meant, so it is refused unless the owner confirmed that the server is
 * on their own network. A metadata or link-local address is refused whatever the owner says.
 */

export type Lookup = (name: string) => Promise<string[]>;

export const lookupAll: Lookup = async (name) => (await dnsLookup(name, { all: true })).map((a) => a.address);

/** A host without its port: `127.0.0.1:7070` is `127.0.0.1`, `[::1]:7070` is `[::1]`. */
export function bareHost(host: string): string {
  const text = host.trim().toLowerCase();
  if (text.startsWith("[")) return text.slice(0, text.indexOf("]") + 1);
  const colon = text.lastIndexOf(":");
  return colon === -1 ? text : text.slice(0, colon);
}

/** The name of a host without its port or brackets. */
function nameOf(host: string): string {
  const bare = bareHost(host);
  return bare.startsWith("[") ? bare.slice(1, -1) : bare;
}

/**
 * Throws a `UserError` when `host` is not allowed. A public name is looked up, since a public name
 * can resolve to a private address (and a rebinding name can change its answer, so a caller that
 * keeps the connection should check again when it calls).
 */
export async function assertHostAllowed(
  host: string,
  options: { allowPrivate?: boolean; lookup?: Lookup } = {},
): Promise<void> {
  const allowPrivate = options.allowPrivate === true;
  const issue = selfHostIssue(host, { allowPrivate });
  if (issue !== undefined) throw new UserError(issue.message, 409);
  const name = nameOf(host);
  if (classifyAddress(name) !== undefined) return;
  let addresses: string[];
  try {
    addresses = await (options.lookup ?? lookupAll)(name);
  } catch (err) {
    const code = errorCode(err);
    throw new UserError(
      code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? `majhi cannot find ${name}. Check the host name.`
        : `majhi could not look up ${name}. Check your connection and try again.`,
      409,
    );
  }
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === "metadata" || kind === "link-local" || kind === "unspecified") {
      throw new UserError(
        `${name} points at a cloud metadata or link-local address. majhi never sends a token there.`,
        409,
      );
    }
    if ((kind === "loopback" || kind === "private" || kind === "reserved") && !allowPrivate) {
      throw new UserError(
        `${name} points at this computer or a private network. Confirm that it is your own server to use it.`,
        409,
      );
    }
  }
}

/**
 * `fetch` that checks each call's host first. For a service whose address the owner typed: its
 * sign-in metadata can name any address, and an attacker's server could name a private one.
 * `confirmed` says whether the owner confirmed that host is on their own network.
 */
export function guardedFetch(
  base: typeof fetch,
  confirmed: (host: string) => boolean,
  lookup?: Lookup,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    await assertHostAllowed(url.host, {
      allowPrivate: confirmed(url.host),
      ...(lookup === undefined ? {} : { lookup }),
    });
    return base(input, init);
  };
}
