import { CommitShaSchema, RepoPathSchema } from "@majhi/shared";
import { git } from "../git/git.ts";
import type { ProjectService } from "../projects/service.ts";

/** How far a project's base branch has moved past the commit its wiki was built from. */
export interface WikiDrift {
  behind: number;
  /** Files that differ between the built commit and the base tip. */
  changed: string[];
}

/** Reads the drift of one project, or undefined when git cannot say (no such commit, no checkout). */
export type DriftOf = (org: string, project: string, built: string) => Promise<WikiDrift | undefined>;

const MAX_CHANGED = 5000;

/** Drift from the project's own checkout: commits and files between the built commit and the tip of its base branch. */
export function gitDrift(projects: Pick<ProjectService, "infos">): DriftOf {
  return async (org, project, built) => {
    const commit = CommitShaSchema.safeParse(built);
    const info = (await projects.infos()).find((p) => p.id === project && p.org === org);
    if (!commit.success || info === undefined || !info.exists || info.base === undefined) return undefined;
    try {
      const range = `${commit.data}..refs/heads/${info.base}`;
      const behind = Number((await git(info.path, ["rev-list", "--count", range])).trim());
      if (!Number.isInteger(behind)) return undefined;
      const names = behind === 0 ? "" : await git(info.path, ["diff", "--name-only", range]);
      const changed = names
        .split("\n")
        .filter((p) => RepoPathSchema.safeParse(p).success)
        .slice(0, MAX_CHANGED);
      return { behind, changed };
    } catch {
      return undefined;
    }
  };
}
