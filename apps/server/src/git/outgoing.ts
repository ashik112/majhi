import { TASK_TRAILER } from "@majhi/shared";
import { git, gitOk } from "./git.ts";

/**
 * What leaves majhi in git carries no majhi bookkeeping. A task branch collects `wip(<task>):
 * checkpoint N` commits and `Majhi-Task` trailers while agents work. Before the branch is first
 * pushed, or merged into its base here, the commits not yet published are made clean: collapsed
 * into one commit when they hold a checkpoint (or a merge), else rewritten with the trailer
 * removed. Commits the remote already has are never touched, so there is never a force push.
 */

export interface Person {
  name: string;
  email: string;
}

export interface OutgoingRequest {
  /** The project's checkout. Its git folder is shared with the task's worktree. */
  source: string;
  branch: string;
  /** The base branch: the fork point is where the branch left it. */
  base: string;
  /** The commit a stacked branch sits on. The range starts there, not at the base. */
  stackCommit?: string | undefined;
  /**
   * The remote-tracking ref of the branch when the branch was pushed before, else undefined. The
   * range starts at that tip, and a pushed branch whose ref is gone or has diverged is left alone.
   */
  published?: { ref: string } | undefined;
  taskId: string;
  /** The subject of the one commit that replaces a branch with checkpoints. */
  subject: string;
  /** Author and committer of that commit. */
  identity: Person;
}

export type OutgoingResult =
  | { changed: false }
  | { changed: true; how: "collapsed" | "stripped"; from: string; to: string };

/** The subject `wip(<task>): checkpoint N` that `commitCheckpoint` writes. */
export function isCheckpointSubject(subject: string, taskId: string): boolean {
  const prefix = `wip(${taskId}): checkpoint `;
  if (!subject.startsWith(prefix)) return false;
  const n = subject.slice(prefix.length);
  return n !== "" && Number.isInteger(Number(n));
}

/** The message without its `Majhi-Task` trailer lines. */
export function withoutTaskTrailer(message: string): string {
  const kept = message.split("\n").filter((line) => !line.startsWith(`${TASK_TRAILER}:`));
  return `${kept.join("\n").trimEnd()}\n`;
}

interface CommitRow {
  hash: string;
  tree: string;
  parents: string[];
  message: string;
  author: { name: string; email: string; date: string };
  committer: { name: string; email: string; date: string };
}

const FIELD = "\u001f";
const RECORD = "\u001e";

async function rows(source: string, range: string): Promise<CommitRow[]> {
  const format = ["%H", "%T", "%P", "%an", "%ae", "%ad", "%cn", "%ce", "%cd", "%B"].join(FIELD);
  const out = await git(source, ["log", "--reverse", "--date=raw", `--format=${format}${RECORD}`, range]);
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim() !== "")
    .map((record) => {
      const [
        hash = "",
        tree = "",
        parents = "",
        an = "",
        ae = "",
        ad = "",
        cn = "",
        ce = "",
        cd = "",
        ...body
      ] = record.split(FIELD);
      return {
        hash,
        tree,
        parents: parents.split(" ").filter((p) => p !== ""),
        message: body.join(FIELD),
        author: { name: an, email: ae, date: ad },
        committer: { name: cn, email: ce, date: cd },
      };
    });
}

/** Where the unpublished commits start, or undefined when the branch must be left as it is. */
async function rangeBase(req: OutgoingRequest, tip: string): Promise<string | undefined> {
  if (req.published !== undefined) {
    const sha = await git(req.source, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${req.published.ref}^{commit}`,
    ]).then(
      (s) => s.trim(),
      () => undefined,
    );
    if (sha === undefined || !(await gitOk(req.source, ["merge-base", "--is-ancestor", sha, tip])))
      return undefined;
    return sha;
  }
  if (
    req.stackCommit !== undefined &&
    (await gitOk(req.source, ["merge-base", "--is-ancestor", req.stackCommit, tip]))
  ) {
    return req.stackCommit;
  }
  const fork = await git(req.source, ["merge-base", tip, req.base]).catch(() => "");
  return fork.trim() === "" ? undefined : fork.trim();
}

async function commitTree(
  source: string,
  row: { tree: string; parent: string; message: string },
  author: { name: string; email: string; date?: string },
  committer: { name: string; email: string; date?: string },
): Promise<string> {
  const e = {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    ...(author.date === undefined ? {} : { GIT_AUTHOR_DATE: author.date }),
    ...(committer.date === undefined ? {} : { GIT_COMMITTER_DATE: committer.date }),
  };
  const out = await git(
    source,
    ["-c", "commit.gpgsign=false", "commit-tree", row.tree, "-p", row.parent, "-m", row.message],
    { env: e },
  );
  return out.trim();
}

/**
 * Makes the branch's unpublished commits clean and moves the branch ref to the result, only if it
 * still points where it did (`update-ref` with the old value). The tree never changes, so the
 * worktree and its index stay in step.
 */
export async function cleanOutgoing(req: OutgoingRequest): Promise<OutgoingResult> {
  const ref = `refs/heads/${req.branch}`;
  const tip = (await git(req.source, ["rev-parse", "--verify", ref])).trim();
  const base = await rangeBase(req, tip);
  if (base === undefined || base === tip) return { changed: false };
  const commits = await rows(req.source, `${base}..${tip}`);
  if (commits.length === 0) return { changed: false };
  const collapse = commits.some(
    (c) => c.parents.length > 1 || isCheckpointSubject(firstLine(c.message), req.taskId),
  );
  const dirty = commits.some((c) => c.message.split("\n").some((l) => l.startsWith(`${TASK_TRAILER}:`)));
  if (!collapse && !dirty) return { changed: false };

  let to: string;
  if (collapse) {
    const last = commits.at(-1) as CommitRow;
    to = await commitTree(
      req.source,
      { tree: last.tree, parent: base, message: `${req.subject}\n` },
      req.identity,
      req.identity,
    );
  } else {
    let parent = base;
    for (const c of commits) {
      parent = await commitTree(
        req.source,
        { tree: c.tree, parent, message: withoutTaskTrailer(c.message) },
        c.author,
        c.committer,
      );
    }
    to = parent;
  }
  await git(req.source, ["update-ref", ref, to, tip]);
  return { changed: true, how: collapse ? "collapsed" : "stripped", from: tip, to };
}

function firstLine(message: string): string {
  return message.split("\n")[0] ?? "";
}

/** The remote-tracking ref of a branch (`refs/remotes/origin/<branch>`) when a remote has it, else undefined. */
export async function trackingRefOf(source: string, branch: string): Promise<string | undefined> {
  const out = await git(source, ["for-each-ref", "--format=%(refname)", "refs/remotes"]).catch(() => "");
  return out.split("\n").find((ref) => ref.split("/").slice(3).join("/") === branch);
}
