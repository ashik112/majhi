import { type ParsedTask, taskKindOf } from "@majhi/shared";
import { UserError } from "../errors.ts";

/** One repo a task creator listed on purpose. */
export interface PickedRepo {
  project: string;
  base?: string | undefined;
  /** Owner only, for a protected project: agents may write in it for this task. */
  writes?: boolean | undefined;
}

/**
 * A task's repos are the ones its creator listed: the owner's project chips, or `repos` from the
 * boss, a lead or an automation. Project names in the text attach nothing, so a brief that says
 * "read X, do not change it" never gives X a branch. Returns the parse with those repos, the base
 * picked per repo, and the projects the text named that did not join, to say so in the room.
 */
export function withPickedRepos(
  text: string,
  parsed: ParsedTask,
  picked: readonly PickedRepo[] | undefined,
  projects: readonly { id: string; org: string; protected?: boolean }[],
  byOwner = false,
): {
  parsed: ParsedTask;
  bases: Map<string, string>;
  mentioned: string[];
  /** Protected projects a creator other than the owner listed: left out. */
  refused: string[];
  /** Protected projects the owner let agents write in. */
  writes: Set<string>;
} {
  const repos: ParsedTask["repos"] = [];
  const bases = new Map<string, string>();
  const refused: string[] = [];
  const writes = new Set<string>();
  for (const pick of picked ?? []) {
    const project = projects.find((p) => p.id === pick.project);
    if (project === undefined) {
      throw new UserError(`Project "${pick.project}" does not exist.`, 404);
    }
    if (repos.some((r) => r.project === pick.project)) continue;
    // A protected project joins a task only when the owner adds it.
    if (project.protected === true && !byOwner) {
      if (!refused.includes(pick.project)) refused.push(pick.project);
      continue;
    }
    if (project.protected === true && byOwner && pick.writes === true) writes.add(pick.project);
    repos.push({ project: pick.project, match: pick.project });
    if (pick.base !== undefined) bases.set(pick.project, pick.base);
  }
  const orgs = [...new Set(repos.flatMap((r) => projects.find((p) => p.id === r.project)?.org ?? []))];
  const warnings = parsed.warnings.filter((w) => !w.startsWith("Repos from more than one org"));
  if (orgs.length > 1) warnings.push(`Repos from more than one org: ${orgs.join(", ")}`);
  const { org: _named, ...rest } = parsed;
  // The kind as the words say it for the repos that joined: an investigation stays ops.
  const kind = taskKindOf(text, repos.length > 0);
  const out: ParsedTask = { ...rest, repos, kind, warnings };
  if (orgs.length === 1 && orgs[0] !== undefined) out.org = orgs[0];
  const mentioned = parsed.repos
    .map((r) => r.project)
    .filter((p) => !repos.some((r) => r.project === p) && !refused.includes(p));
  return { parsed: out, bases, mentioned, refused, writes };
}
