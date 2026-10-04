import { type ConnectionConfig, GLOBAL_CONNECTIONS } from "@majhi/shared";

/** One connection a run gets, with the org it belongs to. */
export interface HeldConnection {
  id: string;
  org: string;
  connection: ConnectionConfig;
}

/**
 * The connections one run gets (SPEC 5.14):
 *   - an org agent gets every connection of its own org, and only in a task of that org, so never
 *     another org's, even where `where` lets it work;
 *   - a root agent gets every connection of the task's org, plus the ones the task names or had
 *     attached, of any org;
 *   - in a task without an org, a root agent gets only the ones the task names or had attached.
 * A connection whose `agents_off` names the agent never reaches it. An id that names no connection
 * is left out.
 */
export function runConnections(input: {
  /** No id: every agent at once, as redaction needs. */
  agent: { id?: string | undefined; scope: string };
  task: { org: string | undefined; connections: readonly string[] };
  global?: Readonly<Record<string, ConnectionConfig>> | undefined;
  orgs: Readonly<Record<string, { connections?: Readonly<Record<string, ConnectionConfig>> | undefined }>>;
}): HeldConnection[] {
  const { agent, task, orgs } = input;
  const shared = Object.entries(input.global ?? {}).map(([id, connection]) => ({
    id,
    org: GLOBAL_CONNECTIONS,
    connection,
  }));
  const of = (org: string): HeldConnection[] =>
    Object.entries(orgs[org]?.connections ?? {}).map(([id, connection]) => ({ id, org, connection }));
  const byId = (id: string): HeldConnection | undefined => {
    const global = shared.find((c) => c.id === id);
    if (global !== undefined) return global;
    for (const [org, entry] of Object.entries(orgs)) {
      const connection = entry.connections?.[id];
      if (connection !== undefined) return { id, org, connection };
    }
    return undefined;
  };
  const on = (c: HeldConnection) =>
    agent.id === undefined || !(c.connection.agents_off ?? []).includes(agent.id);
  if (agent.scope !== "root") {
    if (task.org === undefined || task.org !== agent.scope) return [];
    return [...of(agent.scope), ...shared].filter(on);
  }
  const out = task.org === undefined ? [] : of(task.org);
  for (const id of task.connections) {
    if (out.some((c) => c.id === id)) continue;
    const found = byId(id);
    if (found !== undefined) out.push(found);
  }
  return [...out, ...shared.filter((c) => !out.some((held) => held.id === c.id))].filter(on);
}
