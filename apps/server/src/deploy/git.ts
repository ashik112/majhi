import { git, gitOk, refIsThere } from "../git/git.ts";

/** What a deploy reads from a project's repository. Read only. */
export interface DeployGit {
  /** The newest tip of the base branch: the local branch and each remote's copy, whichever contains the others. */
  tip(path: string, base: string): Promise<string | undefined>;
}

export const deployGit: DeployGit = {
  async tip(path, base) {
    try {
      const remotes = (await git(path, ["remote"])).split("\n").filter((r) => r.trim() !== "");
      const refs = [`refs/heads/${base}`, ...remotes.map((r) => `refs/remotes/${r.trim()}/${base}`)];
      const tips: string[] = [];
      for (const ref of refs) {
        if (await refIsThere(path, ref)) tips.push((await git(path, ["rev-parse", ref])).trim());
      }
      let best: string | undefined;
      for (const tip of tips) {
        if (
          best === undefined ||
          (tip !== best && (await gitOk(path, ["merge-base", "--is-ancestor", best, tip])))
        ) {
          best = tip;
        } else if (tip !== best && !(await gitOk(path, ["merge-base", "--is-ancestor", tip, best]))) {
          // Two copies that each have commits the other lacks: no single head to deploy.
          return undefined;
        }
      }
      return best;
    } catch {
      return undefined;
    }
  },
};
