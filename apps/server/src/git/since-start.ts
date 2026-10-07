import { git, gitOk, refIsThere } from "./git.ts";
import { refId } from "./refs.ts";

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
  const key = await memoKey(cwd, repo, tip, refs, options.mergeBase === true);
  const known = key === undefined ? undefined : measured.get(key);
  if (known !== undefined) return known;
  const found = await measureChangeBase(cwd, repo, tip, refs, options);
  if (key !== undefined) remember(key, found);
  return found;
}

/**
 * What `changeBase` found, by the commits it was found from. Ancestry between commits never changes,
 * so the same commits give the same answer; a branch that moved is another key. A ship asks this
 * for each repo a dozen times (the diff, the checks, the plan, the card), each a chain of git runs.
 */
const measured = new Map<string, ChangeBase>();
const MEASURED_LIMIT = 500;

function remember(key: string, value: ChangeBase): void {
  if (measured.size >= MEASURED_LIMIT) {
    const oldest = measured.keys().next();
    if (oldest.done !== true) measured.delete(oldest.value);
  }
  measured.set(key, value);
}

const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The commits an answer depends on, as one string. Undefined when any of them cannot be read from the
 * ref files (a start that is not a full id, a tip that is neither a branch ref nor an id): then git is
 * asked every time.
 */
async function memoKey(
  cwd: string,
  repo: Repo,
  tip: string,
  refs: readonly Candidate[],
  mergeBase: boolean,
): Promise<string | undefined> {
  const tipId = COMMIT_ID.test(tip) ? tip : await refId(cwd, tip);
  if (typeof tipId !== "string") return undefined;
  if (!mergeBase && repo.startCommit !== undefined && !COMMIT_ID.test(repo.startCommit)) return undefined;
  const parts = [cwd, repo.base, repo.branch, mergeBase ? "" : (repo.startCommit ?? ""), tipId];
  for (const ref of refs) {
    const id = await refId(cwd, ref.name);
    if (typeof id !== "string") return undefined;
    parts.push(ref.name, ref.label, id);
  }
  return parts.join("\0");
}

async function measureChangeBase(
  cwd: string,
  repo: Repo,
  tip: string,
  refs: readonly Candidate[],
  options: { mergeBase?: boolean },
): Promise<ChangeBase> {
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
interface Candidate {
  name: string;
  label: string;
}

async function baseCandidates(cwd: string, base: string): Promise<Candidate[]> {
  const remotes = (await git(cwd, ["remote"]))
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r !== "");
  const out: Candidate[] = [];
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
