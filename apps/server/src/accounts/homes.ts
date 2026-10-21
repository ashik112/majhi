import { join } from "node:path";
import { type AccountRuntime, agentHomePath, INTERNAL_ORG } from "@majhi/acp";
import { type AccountConfig, PRIVATE, type Task } from "@majhi/shared";

/** `<majhi home>/accounts/<id>`: the account's own folder. Ids cannot contain slashes or dots. Sign-in, probes and usage reads only. */
export function accountHome(majhiHome: string, id: string): string {
  return join(majhiHome, "accounts", id);
}

/**
 * The account as a probe, a login and a usage read use it: its own folder is the config home. Never for an
 * agent session (`sessionRuntime`): no run mounts this folder.
 */
export function accountRuntime(
  majhiHome: string,
  id: string,
  config: AccountConfig,
  apiKey?: string,
): AccountRuntime {
  const account: AccountRuntime = { tool: config.tool, home: accountHome(majhiHome, id) };
  if (apiKey !== undefined) account.apiKey = apiKey;
  return account;
}

/**
 * The account as an agent session uses it. In a runner (`isolated`): its workspace's own home,
 * `agent-homes/<org>/<account>`, with the account's folder only as the source of its sign-in file and of what a
 * new home is seeded with. Next to majhi (`MAJHI_RUNNER=local`) agents have no isolation at all, so a workspace
 * home would add nothing, and Claude refuses the link that would share the sign-in: the account folder stays the
 * home, as it always was there.
 */
export function sessionRuntime(
  majhiHome: string,
  id: string,
  config: AccountConfig,
  org: string,
  isolated: boolean,
  apiKey?: string,
): AccountRuntime {
  if (!isolated) return accountRuntime(majhiHome, id, config, apiKey);
  const account: AccountRuntime = {
    tool: config.tool,
    home: agentHomePath(majhiHome, org, id),
    accountHome: accountHome(majhiHome, id),
  };
  if (apiKey !== undefined) account.apiKey = apiKey;
  return account;
}

/**
 * Whose home a task's sessions use. A workspace's task: that workspace's. A chat with no workspace (the
 * captain across all workspaces, the autonomy chat): the internal home, which no workspace's agent ever gets.
 * Any other task with no org (a LOCAL task is an arbitrary agent on arbitrary code): the Private workspace's,
 * never the captain's, so what it plants cannot reach a session that holds the admin tools.
 */
export function taskHomeOrg(task: Pick<Task, "org" | "kind">): string {
  if (task.org !== undefined) return task.org;
  return task.kind === "chat" ? INTERNAL_ORG : PRIVATE;
}

/** The secret name behind `key: secret:<name>`. */
export function secretName(ref: string): string {
  return ref.replace(/^secret:/, "");
}
