import { readFile } from "node:fs/promises";
import { normalizeSshRoute } from "@majhi/shared";
import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { editConfig } from "./write.ts";

/**
 * A project's remote used to name an SSH alias (`remotes.<name>.ssh`) and a host (`remotes.<name>.host`).
 * How a push reaches a host is now one thing: the workspace's git account for it (`orgs.<id>.git_accounts`,
 * its `ssh` route). This moves what the owner had set, once, and drops the two keys.
 *
 * An alias becomes the route of the workspace's account for the alias's host, unless that account already
 * has a route. Without an account the alias is left out: the remote URL keeps working as it is, and the
 * migration says so.
 */

const LegacyFileSchema = z.looseObject({
  projects: z
    .record(
      z.string(),
      z.looseObject({
        org: z.string().optional(),
        path: z.string().optional(),
        remotes: z
          .record(z.string(), z.looseObject({ ssh: z.string().optional(), host: z.string().optional() }))
          .optional(),
      }),
    )
    .optional(),
  orgs: z
    .record(
      z.string(),
      z.looseObject({
        git_accounts: z.array(z.looseObject({ host: z.string(), ssh: z.string().optional() })).optional(),
      }),
    )
    .optional(),
});

/** One remote of a project that still carries the old keys. */
export interface LegacyRemote {
  project: string;
  org: string;
  /** The project's path as the file has it. */
  path: string;
  remote: string;
  /** The SSH alias the remote named, when it did. */
  alias: string | undefined;
}

interface Found {
  remotes: LegacyRemote[];
  accounts: Record<string, { host: string; ssh: string | undefined }[]>;
}

async function readFound(file: string): Promise<Found> {
  const text = await readFile(file, "utf8").catch(() => "");
  const parsed = LegacyFileSchema.safeParse(parseDocument(text).toJS());
  if (!parsed.success) return { remotes: [], accounts: {} };
  const remotes: LegacyRemote[] = [];
  for (const [project, p] of Object.entries(parsed.data.projects ?? {})) {
    for (const [remote, r] of Object.entries(p.remotes ?? {})) {
      if (r.ssh === undefined && r.host === undefined) continue;
      remotes.push({
        project,
        org: p.org ?? "private",
        path: p.path ?? "",
        remote,
        alias: r.ssh?.trim() === "" ? undefined : r.ssh?.trim(),
      });
    }
  }
  const accounts: Found["accounts"] = {};
  for (const [org, o] of Object.entries(parsed.data.orgs ?? {})) {
    accounts[org] = (o.git_accounts ?? []).map((a) => ({ host: a.host.toLowerCase(), ssh: a.ssh }));
  }
  return { remotes, accounts };
}

/** The real host name an alias of a remote reaches, or undefined when it cannot be told. */
export type AliasHostOf = (remote: LegacyRemote & { alias: string }) => Promise<string | undefined>;

export interface RoutePlan {
  /** The routes to write: the account of `org` for `host` takes `ssh`. */
  routes: { org: string; host: string; ssh: string }[];
  moved: string[];
  /** Aliases left out, each with the reason. */
  left: string[];
}

/**
 * Which aliases move to which account. Pure: `hosts` holds the real host of each alias (by project and
 * remote), `accounts` the workspaces' accounts as they are now. A route already set, in the file or by an
 * earlier alias of this plan, is never replaced.
 */
export function planRoutes(
  remotes: readonly LegacyRemote[],
  hosts: ReadonlyMap<string, string | undefined>,
  accounts: Found["accounts"],
): RoutePlan {
  const working = new Map(
    Object.entries(accounts).map(([org, list]) => [org, list.map((a) => ({ ...a }))] as const),
  );
  const plan: RoutePlan = { routes: [], moved: [], left: [] };
  for (const r of remotes) {
    if (r.alias === undefined) continue;
    const name = `${r.project} ${r.remote} (${r.alias})`;
    const host = hosts.get(legacyKey(r));
    if (host === undefined) {
      plan.left.push(`${name}: its host is not known`);
      continue;
    }
    const account = working.get(r.org)?.find((a) => a.host === host);
    if (account === undefined) {
      plan.left.push(`${name}: ${r.org} has no git account for ${host}`);
      continue;
    }
    const route = normalizeSshRoute(host, r.alias);
    if (route === undefined) continue;
    if (account.ssh !== undefined) {
      if (account.ssh !== route)
        plan.left.push(`${name}: the ${r.org} account for ${host} already routes via ${account.ssh}`);
      continue;
    }
    account.ssh = route;
    plan.routes.push({ org: r.org, host, ssh: route });
    plan.moved.push(`${name} to ${r.org} on ${host}`);
  }
  return plan;
}

function legacyKey(r: Pick<LegacyRemote, "project" | "remote">): string {
  return `${r.project}\n${r.remote}`;
}

function summaryOf(plan: RoutePlan): string {
  const parts = ["Project SSH aliases and hosts moved to the workspace git accounts"];
  if (plan.moved.length > 0) parts.push(`moved: ${plan.moved.join("; ")}`);
  if (plan.left.length > 0) parts.push(`left as the remote URL has them: ${plan.left.join("; ")}`);
  return parts.join(". ");
}

/** Reads what is stale, resolves each alias to its host, and plans the moves. Undefined when nothing is stale. */
export async function planRemoteRoutes(
  file: string,
  hostOf: AliasHostOf,
): Promise<(RoutePlan & { summary: string }) | undefined> {
  const found = await readFound(file);
  if (found.remotes.length === 0) return undefined;
  const hosts = new Map<string, string | undefined>();
  for (const r of found.remotes) {
    if (r.alias === undefined) continue;
    hosts.set(legacyKey(r), (await hostOf({ ...r, alias: r.alias }).catch(() => undefined))?.toLowerCase());
  }
  const plan = planRoutes(found.remotes, hosts, found.accounts);
  return { ...plan, summary: summaryOf(plan) };
}

/** Writes the routes, and removes `ssh` and `host` from every project remote, with the entries they leave empty. */
export function applyRemoteRoutes(file: string, routes: RoutePlan["routes"]): Promise<void> {
  return editConfig(file, (doc) => {
    for (const route of routes) {
      const accounts = doc.getIn(["orgs", route.org, "git_accounts"], true);
      if (!isSeq(accounts)) continue;
      for (const item of accounts.items) {
        if (!isMap(item) || String(item.get("host")).toLowerCase() !== route.host || item.has("ssh"))
          continue;
        item.set("ssh", route.ssh);
        break;
      }
    }
    const projects = doc.get("projects", true);
    if (!isMap(projects)) return;
    for (const pair of projects.items) {
      const remotes = isMap(pair.value) ? pair.value.get("remotes", true) : undefined;
      if (!isMap(remotes)) continue;
      for (const entry of [...remotes.items]) {
        if (!isMap(entry.value)) continue;
        entry.value.delete("ssh");
        entry.value.delete("host");
        if (entry.value.items.length === 0) remotes.items.splice(remotes.items.indexOf(entry), 1);
      }
      if (remotes.items.length === 0 && isMap(pair.value)) pair.value.delete("remotes");
    }
  });
}
