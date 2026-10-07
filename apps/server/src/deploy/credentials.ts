import { type ConnectionConfig, textValue } from "@majhi/shared";
import type { PlanDeps } from "../connections/plan.ts";
import type { DeployCredentials } from "./types.ts";

/**
 * The only way a deploy reaches a credential: through the project's own workspace. A run on a git host uses
 * the workspace's git account for that host; other runs use a connection of the workspace. A connection of
 * another workspace, or of another kind than the run needs, is refused with a sentence, so one workspace's
 * deploys can never use another's keys. A value is returned to the provider that
 * calls with it and goes nowhere else: not into a record, a log or a command line.
 */

export interface CredentialDeps {
  connections: {
    find(id: string): Promise<{ org: string; connection: ConnectionConfig } | undefined>;
  };
  secrets: { get(name: string): Promise<string | undefined> };
  /** The workspace's own sign-in to a git host, renewed when it ends soon. */
  gitToken: NonNullable<PlanDeps["gitToken"]>;
}

const SECRET = "secret:";

export function createDeployCredentials(deps: CredentialDeps): DeployCredentials {
  type Own = { ok: true; connection: ConnectionConfig } | { ok: false; problem: string };
  const own = async (org: string, id: string, type: ConnectionConfig["type"], what: string): Promise<Own> => {
    const found = await deps.connections.find(id);
    if (found === undefined || found.org !== org) {
      return {
        ok: false,
        problem: `${org} has no connection ${id}. A deploy only uses its own workspace's connections.`,
      };
    }
    if (found.connection.type !== type) return { ok: false, problem: `${id} is not ${what}.` };
    return { ok: true, connection: found.connection };
  };

  return {
    // The workspace's git account for the host, which is what a merge request or a push signs in with.
    git: (org, host, provider) => deps.gitToken(org, provider, host),

    async variable(org, id, name) {
      const got = await own(org, id, "env", "a variables connection");
      if (!got.ok) return { problem: got.problem };
      const entry = got.connection.vars?.[name];
      if (entry?.value === undefined) return { problem: `${id} has no ${name}.` };
      if (entry.kind === "text") return { value: entry.value };
      if (entry.kind === "secret" && entry.value.startsWith(SECRET)) {
        const value = await deps.secrets.get(entry.value.slice(SECRET.length));
        return value === undefined ? { problem: `${name} of ${id} is not saved yet.` } : { value };
      }
      return { problem: `${name} of ${id} is not a value a deploy can use.` };
    },

    async ssh(org, id) {
      const got = await own(org, id, "ssh", "an SSH host");
      if (!got.ok) return { problem: got.problem };
      const alias = textValue(got.connection, "alias");
      if (alias === undefined) return { problem: `${id} has no host.` };
      const key = textValue(got.connection, "key");
      return { alias, ...(key === undefined ? {} : { key }) };
    },
  };
}
