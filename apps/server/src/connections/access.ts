import type { ConnectionConfig } from "@majhi/shared";

/** One connection a run gets, with the org it belongs to. */
export interface HeldConnection {
  id: string;
  org: string;
  connection: ConnectionConfig;
}

/**
 * The connections one run gets (SPEC 5.14):
 *   - an org agent gets the connections of its own org that its `connections` lists, and only in a
 *     task of that org, so never another org's, even where `where` lets it work;
 *   - a root agent gets every connection of the task's org, plus the ones the task names or had
 *     attached, of any org;
 *   - in a task without an org, a root agent gets only the ones the task names or had attached.
 * An id that names no connection is left out.
 */
export function runConnections(input: {
  agent: { scope: string; connections: readonly string[] };
  task: { org: string | undefined; connections: readonly string[] };
  orgs: Readonly<Record<string, { connections?: Readonly<Record<string, ConnectionConfig>> | undefined }>>;
}): HeldConnection[] {
  const { agent, task, orgs } = input;
  const of = (org: string): HeldConnection[] =>
    Object.entries(orgs[org]?.connections ?? {}).map(([id, connection]) => ({ id, org, connection }));
  const byId = (id: string): HeldConnection | undefined => {
    for (const [org, entry] of Object.entries(orgs)) {
      const connection = entry.connections?.[id];
      if (connection !== undefined) return { id, org, connection };
    }
    return undefined;
  };
  if (agent.scope !== "root") {
    if (task.org === undefined || task.org !== agent.scope) return [];
    return of(agent.scope).filter((c) => agent.connections.includes(c.id));
  }
  const out = task.org === undefined ? [] : of(task.org);
  for (const id of task.connections) {
    if (out.some((c) => c.id === id)) continue;
    const found = byId(id);
    if (found !== undefined) out.push(found);
  }
  return out;
}
