import { git, gitOk, refIsThere } from "./git.ts";

type Repo = {
  source: string;
  base: string;
  branch: string;
  startCommit?: string | undefined;
};

export interface ChangeBase {
  /** The commit "what this task changed" is measured from. */
  commit: string;
  /** How to name it for the owner: `origin/main` or `main`. */
  label: string;
}

/**
 * The commit a task's changes start from. The recorded `startCommit` when the branch still holds it.
 * Else (older tasks, branches the owner named, branches rebased since) the newest copy of the base
 * the branch contains: the local base or any remote's, whichever merge base is closest to the tip.
 * The local base can lag far behind the remote's, so it is never the only candidate.
 * `tip` is a ref or sha in `cwd`. Throws when no base shares history with the tip.
 */
export async function changeBase(
  cwd: string,
  repo: Repo,
  tip: string,
  /** `mergeBase`: ignore the recorded start and measure from where the branch meets its base now, which is what a merge request carries. */
  options: { mergeBase?: boolean } = {},
): Promise<ChangeBase> {
  const refs = await baseCandidates(cwd, repo.base);
  if (
    options.mergeBase !== true &&
    repo.startCommit !== undefined &&
    (await gitOk(cwd, ["merge-base", "--is-ancestor", repo.startCommit, tip]))
  ) {
    const commit = (await git(cwd, ["rev-parse", repo.startCommit])).trim();
    for (const ref of [...refs].reverse()) {
      if (await gitOk(cwd, ["merge-base", "--is-ancestor", commit, ref.name]))
        return { commit, label: ref.label };
    }
    return { commit, label: repo.base };
  }
  let best: (ChangeBase & { ahead: number }) | undefined;
  for (const ref of refs) {
    const commit = (await git(cwd, ["merge-base", ref.name, tip]).catch(() => "")).trim();
    if (commit === "") continue;
    const ahead = Number((await git(cwd, ["rev-list", "--count", `${commit}..${tip}`])).trim());
    if (best === undefined || ahead < best.ahead) best = { commit, label: ref.label, ahead };
  }
  if (best === undefined) throw new Error(`${repo.branch} shares no history with ${repo.base}.`);
  return { commit: best.commit, label: best.label };
}

/** The local base first, then each remote's copy of it, those that exist. */
async function baseCandidates(cwd: string, base: string): Promise<{ name: string; label: string }[]> {
  const remotes = (await git(cwd, ["remote"]))
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r !== "");
  const out: { name: string; label: string }[] = [];
  if (await refIsThere(cwd, `refs/heads/${base}`)) out.push({ name: `refs/heads/${base}`, label: base });
  for (const r of remotes) {
    if (await refIsThere(cwd, `refs/remotes/${r}/${base}`))
      out.push({ name: `refs/remotes/${r}/${base}`, label: `${r}/${base}` });
  }
  return out;
}

/** Commits from the change base to the tip. Zero means the branch has not moved since it started. */
export async function commitsSinceStart(cwd: string, repo: Repo): Promise<number> {
  const { commit } = await changeBase(cwd, repo, `refs/heads/${repo.branch}`);
  return (
    Number((await git(cwd, ["rev-list", "--count", `${commit}..refs/heads/${repo.branch}`])).trim()) || 0
  );
}
