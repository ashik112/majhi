import { GLOBAL_SCOPE, type MemoryScope, orgScope, PRIVATE, parseScope, projectScope } from "@majhi/shared";

/**
 * Which workspace's memory chore looks at which memories (SPEC 5.18, Memory). Pure. A workspace
 * reviews its own scope and its projects'. Global memories belong to no client, so Private, the
 * owner's own workspace, reviews them too; a client workspace never sees them, nor another
 * workspace's memories.
 */

type Projects = Readonly<Record<string, { org: string }>>;

/** The scopes the workspace's memory chore reviews. */
export function laneScopes(org: string, projects: Projects): MemoryScope[] {
  return [
    ...(org === PRIVATE ? [GLOBAL_SCOPE] : []),
    orgScope(org),
    ...Object.entries(projects)
      .filter(([, p]) => p.org === org)
      .map(([id]) => projectScope(id)),
  ];
}

/** The workspace whose memory chore reviews the scope. Undefined for a project majhi no longer knows. */
export function laneOfScope(scope: MemoryScope, projects: Projects): string | undefined {
  const parsed = parseScope(scope);
  if (parsed === undefined) return undefined;
  if (parsed.kind === "global") return PRIVATE;
  if (parsed.kind === "org") return parsed.id;
  return projects[parsed.id]?.org;
}
