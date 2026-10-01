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

/**
 * Scopes recalled into a chat: what a task of its org gets, plus the projects the chat names or
 * reads. A project counts only when it belongs to the chat's org; a chat with a root agent (no
 * org) may use any org's project.
 */
export function chatRecallScopes(
  task: ScopeTask,
  projectOrgs: ProjectOrgs,
  mentioned: readonly string[],
): MemoryScope[] {
  const scopes = recallScopes(task, projectOrgs);
  for (const project of mentioned) {
    const org = projectOrgs.get(project);
    if (org !== undefined && (task.org === undefined || org === task.org)) scopes.push(projectScope(project));
  }
  return [...new Set(scopes)];
}
