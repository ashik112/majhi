import type { RecordRepo, TaskRepo } from "@majhi/shared";
import { git, gitOk, localBranchExists } from "../git/git.ts";

const MAX_COMMITS = 40;
const MAX_STAT_LINES = 40;
/** What the docs diff may add to the Housekeeper's prompt. */
const MAX_DOC_CHARS = 4_000;
/** Docs whose changes on the branch say what was done and decided. */
export const DOC_FILES = ["docs/PROGRESS.md", "docs/DECISIONS.md"] as const;

/** What git says about one repo of a finished task. */
export interface RepoFacts {
  repo: RecordRepo;
  /** `<short hash> <subject>`, oldest first. */
  commits: string[];
  /** `git diff --stat`, cut. */
  stat: string;
  /** Lines the branch added to docs/PROGRESS.md and docs/DECISIONS.md. */
  docs: string;
  /** Set when git could not be read. */
  problem?: string;
}

/**
 * Where the branch's own work starts:
 * - not merged: the merge base with its base;
 * - merged with a merge commit: the first parent of that merge;
 * - fast-forwarded: the first-parent commits made since the task was created.
 * Undefined when there is nothing to read.
 */
async function rangeStart(
  cwd: string,
  base: string,
  tip: string,
  since: string,
): Promise<string | undefined> {
  const merged = await gitOk(cwd, ["merge-base", "--is-ancestor", tip, base]);
  if (!merged) return (await git(cwd, ["merge-base", base, tip])).trim() || undefined;
  const merges = await git(cwd, [
    "rev-list",
    "--reverse",
    "--ancestry-path",
    "--merges",
    "--parents",
    `${tip}..${base}`,
  ]).catch(() => "");
  const tipHash = (await git(cwd, ["rev-parse", tip])).trim();
  for (const line of merges.split("\n")) {
    const [, first, ...others] = line.trim().split(" ");
    if (first !== undefined && others.includes(tipHash)) return first;
  }
  const own = (await git(cwd, ["rev-list", "--first-parent", `--since=${since}`, tip]).catch(() => ""))
    .split("\n")
    .filter((l) => l !== "");
  const oldest = own.at(-1);
  if (oldest === undefined) return undefined;
  return (await gitOk(cwd, ["rev-parse", "--verify", "--quiet", `${oldest}^`])) ? `${oldest}^` : undefined;
}

/** Reads the commits, the diff stat and the docs changes of a task's branch, and where it landed. */
export async function repoFacts(repo: TaskRepo, taskCreatedAt: string): Promise<RepoFacts> {
  const base: RecordRepo = {
    project: repo.project,
    branch: repo.branch,
    base: repo.base,
    merged: repo.mr?.state === "merged",
    commits: 0,
    ...(repo.mr === undefined ? {} : { mr: repo.mr.url }),
  };
  const empty = { commits: [], stat: "", docs: "" };
  const cwd = repo.source;
  try {
    if (!(await localBranchExists(cwd, repo.branch))) {
      return { repo: base, ...empty, problem: "The branch is gone." };
    }
    const tip = `refs/heads/${repo.branch}`;
    const head = (await git(cwd, ["rev-parse", "--short", tip])).trim();
    const merged = base.merged || (await gitOk(cwd, ["merge-base", "--is-ancestor", tip, repo.base]));
    const from = await rangeStart(cwd, repo.base, tip, taskCreatedAt);
    if (from === undefined) return { repo: { ...base, head, merged }, ...empty };
    const range = `${from}..${tip}`;
    const commits = (await git(cwd, ["log", "--no-merges", "--reverse", "--format=%h %s", range]))
      .split("\n")
      .filter((l) => l.trim() !== "");
    const stat = (await git(cwd, ["diff", "--no-color", "--no-ext-diff", "--stat=120", `${from}...${tip}`]))
      .split("\n")
      .filter((l) => l.trim() !== "");
    const statText =
      stat.length > MAX_STAT_LINES
        ? [
            ...stat.slice(0, MAX_STAT_LINES - 1),
            `... ${stat.length - MAX_STAT_LINES} more files`,
            stat.at(-1) ?? "",
          ].join("\n")
        : stat.join("\n");
    const docsDiff = await git(cwd, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-U0",
      `${from}...${tip}`,
      "--",
      ...DOC_FILES,
    ]);
    const added = docsDiff
      .split("\n")
      .filter((l) => (l.startsWith("+") && !l.startsWith("+++")) || l.startsWith("+++ b/"))
      .map((l) => (l.startsWith("+++ b/") ? `[${l.slice(6)}]` : l.slice(1)))
      .join("\n");
    return {
      repo: { ...base, head, merged, commits: commits.length },
      commits: commits.slice(-MAX_COMMITS),
      stat: statText,
      docs: added.length > MAX_DOC_CHARS ? `${added.slice(0, MAX_DOC_CHARS)}\n[cut]` : added,
    };
  } catch (err) {
    return { repo: base, ...empty, problem: err instanceof Error ? err.message : String(err) };
  }
}

/** The facts as prompt text. */
export function factsText(facts: readonly RepoFacts[]): string {
  if (facts.length === 0) return "No repos.";
  return facts
    .map((f) => {
      const r = f.repo;
      const where = r.merged ? `merged into ${r.base}` : `not merged into ${r.base}`;
      const lines = [
        `Repo ${r.project}: branch ${r.branch}, ${where}${r.head === undefined ? "" : `, tip ${r.head}`}, ${r.commits} commit${r.commits === 1 ? "" : "s"}${r.mr === undefined ? "" : `, merge request ${r.mr}`}.`,
      ];
      if (f.problem !== undefined) lines.push(`(git could not be read: ${f.problem})`);
      if (f.commits.length > 0) lines.push("Commits:", ...f.commits.map((c) => `- ${c}`));
      if (f.stat !== "") lines.push("Diff stat:", f.stat);
      if (f.docs !== "") lines.push("Added to the docs on the branch:", f.docs);
      return lines.join("\n");
    })
    .join("\n\n");
}
