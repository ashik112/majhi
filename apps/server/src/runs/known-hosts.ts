import { CONNECTION_TYPES } from "@majhi/shared";
import type { ConfigSections } from "../config/sections.ts";

/** The host of an address or `host:port`, lower case, or undefined. */
function hostOf(value: string): string | undefined {
  const text = value.includes("://") ? value : `https://${value}`;
  try {
    const host = new URL(text).hostname.toLowerCase();
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * The hosts a workspace already knows, derived from its config and kept nowhere else: the live check
 * addresses of its projects' environments, the hosts of its git accounts, and every address or host
 * field of its connections (and the global ones). A command that reaches only these hosts reads nothing
 * an agent could be steered to send somewhere new.
 */
export function knownHosts(sections: ConfigSections, org: string): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | undefined) => {
    const host = value === undefined ? undefined : hostOf(value);
    if (host !== undefined) hosts.add(host);
  };
  for (const project of Object.values(sections.projects)) {
    if (project.org !== org) continue;
    for (const env of project.deploy ?? []) add(env.check);
  }
  for (const account of sections.orgs[org]?.git_accounts ?? []) add(account.host);
  const connections = [
    ...Object.values(sections.orgs[org]?.connections ?? {}),
    ...Object.values(sections.connections ?? {}),
  ];
  for (const connection of connections) {
    const def = CONNECTION_TYPES.find((t) => t.type === connection.type);
    for (const field of def?.fields ?? []) {
      if (field.format === "url" || field.format === "host") add(connection.fields?.[field.key]);
    }
  }
  return hosts;
}
