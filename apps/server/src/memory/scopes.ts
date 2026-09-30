import { GLOBAL_SCOPE, type MemoryScope, orgScope, projectScope } from "@majhi/shared";

export interface ScopeTask {
  org?: string | undefined;
  repos: readonly { project: string }[];
}

/** Which org each registered project belongs to. */
export type ProjectOrgs = ReadonlyMap<string, string>;

/**
 * Scopes recalled into a task's TASK.md: global, the task's org, and the projects of its repos that
 * belong to that org. A task without an org gets global only.
 */
export function recallScopes(task: ScopeTask, projectOrgs: ProjectOrgs): MemoryScope[] {
  const scopes: MemoryScope[] = [GLOBAL_SCOPE];
  if (task.org === undefined) return scopes;
  scopes.push(orgScope(task.org));
  for (const { project } of task.repos) {
    if (projectOrgs.get(project) === task.org) scopes.push(projectScope(project));
  }
  return [...new Set(scopes)];
}

/**
 * Scopes an agent may read and propose in through `majhi-memory`: global, the task's org and every
 * project of that org. Never another org's, whatever the agent asks for.
 */
export function agentScopes(task: ScopeTask, projectOrgs: ProjectOrgs): MemoryScope[] {
  const scopes: MemoryScope[] = [GLOBAL_SCOPE];
  if (task.org === undefined) return scopes;
  scopes.push(orgScope(task.org));
  for (const [project, org] of projectOrgs) if (org === task.org) scopes.push(projectScope(project));
  return scopes;
}
