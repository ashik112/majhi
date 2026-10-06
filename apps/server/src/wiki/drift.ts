import { CommitShaSchema } from "@majhi/shared";
import { git } from "../git/git.ts";
import type { ProjectService } from "../projects/service.ts";
import { changedFiles } from "./git.ts";

/** How far a project's base branch has moved past the commit its wiki was built from. */
export interface WikiDrift {
  behind: number;
  /** Files that differ between the built commit and the base tip. */
  changed: string[];
}

/** Reads the drift of one project, or undefined when git cannot say (no such commit, no checkout). */
export type DriftOf = (org: string, project: string, built: string) => Promise<WikiDrift | undefined>;

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
      const changed =
        behind === 0 ? [] : await changedFiles(info.path, commit.data, `refs/heads/${info.base}`);
      return changed === undefined ? undefined : { behind, changed };
    } catch {
      return undefined;
    }
  };
}
