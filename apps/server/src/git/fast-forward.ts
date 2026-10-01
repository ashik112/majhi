import { git, gitOk } from "./git.ts";
import { checkedOutAt } from "./merge.ts";

export type FastForwardOutcome =
  | { ok: true; moved: boolean; detail: string }
  | { ok: false; reason: string };

/** Paths of a NUL separated git listing. */
const paths = (out: string): string[] => out.split("\0").filter((p) => p !== "");

const sample = (list: readonly string[]): string =>
  list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;

/** An untracked path that sits where an incoming file goes: the same path, or a file where a folder must be. */
function collides(untracked: string, incoming: ReadonlySet<string>): boolean {
  if (incoming.has(untracked)) return true;
  for (const file of incoming) {
    if (file.startsWith(`${untracked}/`) || untracked.startsWith(`${file}/`)) return true;
  }
  return false;
}

/**
 * Moves the local branch `branch` of `source` forward to `to` (a ref already fetched), and only forward:
 * it refuses when the branch has a commit that `to` lacks. Never forces, never resets, touches no other
 * branch. Where the branch is checked out (the source or another worktree), it fast-forwards there only
 * when no incoming file has an uncommitted edit and no untracked path is in the way; other local changes
 * stay as they are. Where it is checked out nowhere, it moves the ref compare-and-swap from the old value.
 */
export async function fastForwardBranch(req: {
  source: string;
  branch: string;
  to: string;
  /** The remote's name, for the reason. */
  remote: string;
}): Promise<FastForwardOutcome> {
  const { source, branch, to, remote } = req;
  const ref = `refs/heads/${branch}`;
  if (!(await gitOk(source, ["show-ref", "--verify", "--quiet", ref]))) {
    return { ok: false, reason: `There is no local branch ${branch} to update.` };
  }
  const old = (await git(source, ["rev-parse", ref])).trim();
  const next = (await git(source, ["rev-parse", "--verify", `${to}^{commit}`])).trim();
  if (old === next || (await gitOk(source, ["merge-base", "--is-ancestor", next, old]))) {
    return { ok: true, moved: false, detail: `${branch} already has everything on ${to}.` };
  }
  if (!(await gitOk(source, ["merge-base", "--is-ancestor", old, next]))) {
    const own = Number((await git(source, ["rev-list", "--count", `${next}..${old}`])).trim());
    return {
      ok: false,
      reason: `local ${branch} has ${own} commit${own === 1 ? "" : "s"} ${remote} lacks; push or merge them first.`,
    };
  }
  const at = (await checkedOutAt(source)).get(branch);
  if (at === undefined) {
    try {
      await git(source, ["update-ref", ref, next, old]);
    } catch {
      return { ok: false, reason: `${branch} moved while it was being updated. Try again.` };
    }
    return { ok: true, moved: true, detail: `Updated ${branch} to ${next.slice(0, 7)}.` };
  }

  const incoming = new Set(paths(await git(at, ["diff", "--name-only", "-z", "--no-renames", old, next])));
  const edited = paths(await git(at, ["diff", "--name-only", "-z", "--no-renames", "HEAD"])).filter((p) =>
    incoming.has(p),
  );
  if (edited.length > 0) {
    return {
      ok: false,
      reason: `${branch} cannot be updated: ${sample(edited)} ${edited.length === 1 ? "has" : "have"} uncommitted changes in ${at}. Commit or stash ${edited.length === 1 ? "it" : "them"} first.`,
    };
  }
  const blocking = paths(await git(at, ["ls-files", "--others", "--exclude-standard", "-z"])).filter((p) =>
    collides(p, incoming),
  );
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: `${branch} cannot be updated: untracked ${sample(blocking)} in ${at} ${blocking.length === 1 ? "is" : "are"} in the way of incoming files. Move or remove ${blocking.length === 1 ? "it" : "them"} first.`,
    };
  }
  try {
    await git(at, ["merge", "--ff-only", "--quiet", next]);
  } catch (err) {
    return {
      ok: false,
      reason: `${branch} could not be fast-forwarded: ${err instanceof Error ? err.message : "git failed"}`,
    };
  }
  return { ok: true, moved: true, detail: `Updated ${branch} to ${next.slice(0, 7)}.` };
}
