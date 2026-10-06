import { WIKI_RULES, type WikiPage } from "@majhi/shared";
import { changedFiles } from "./git.ts";

/** The repo files a page cites, once each: its claims' sources and what its dropped claims pointed at. */
export function citedPaths(page: WikiPage): string[] {
  return [
    ...new Set([
      ...page.claims.flatMap((c) => c.sources.map((s) => s.path)),
      ...page.dropped.flatMap((d) => d.cited.map((c) => c.path)),
    ]),
  ];
}

/** Files changed between a commit and the tip, asked once per commit. */
export class Changes {
  private readonly seen = new Map<string, Promise<ReadonlySet<string> | undefined>>();

  constructor(
    private readonly repoPath: string,
    private readonly tip: string,
  ) {}

  since(commit: string): Promise<ReadonlySet<string> | undefined> {
    let got = this.seen.get(commit);
    if (got === undefined) {
      got = changedFiles(this.repoPath, commit, this.tip).then((files) =>
        files === undefined ? undefined : new Set(files),
      );
      this.seen.set(commit, got);
    }
    return got;
  }
}

/**
 * Why a stored page must be written again, or undefined when it stands: it was written by older rules, the commit
 * it was built from is gone, or a file it cites (or a file that now gives the facts it starts from) changed since.
 */
export async function staleReason(
  page: WikiPage,
  sources: readonly string[],
  leads: readonly string[],
  project: string,
  rules: number,
  changes: Changes,
): Promise<"rules" | "history" | "changed" | undefined> {
  if (page.v !== WIKI_RULES || rules !== WIKI_RULES) return "rules";
  const built = page.builtFrom[project];
  if (built === undefined) return "history";
  const changed = await changes.since(built);
  if (changed === undefined) return "history";
  return [...sources, ...leads].some((path) => changed.has(path)) ? "changed" : undefined;
}

/** A project of a workspace as freshness sees it: where it is, and the files that changed since a commit, up to the commit its facts were read at. */
export interface WorkspaceMember {
  id: string;
  changes: Changes;
}

/**
 * Why a stored workspace page must be written again, or undefined when it stands: it was written by older rules, a
 * project joined that it was not built from, a commit it was built from is gone, or a file it cites in some repo
 * changed in that repo since. A project update marks the workspace pages that cite it this way and no others.
 */
export async function staleWorkspaceReason(
  page: WikiPage,
  rules: number,
  members: readonly WorkspaceMember[],
): Promise<"rules" | "repos" | "history" | "changed" | undefined> {
  if (page.v !== WIKI_RULES || rules !== WIKI_RULES) return "rules";
  if (members.some((m) => page.builtFrom[m.id] === undefined)) return "repos";
  for (const m of members) {
    const built = page.builtFrom[m.id];
    if (built === undefined) continue;
    const cited = new Set(
      page.claims.flatMap((c) => c.sources.filter((s) => s.repo === m.id).map((s) => s.path)),
    );
    if (cited.size === 0) continue;
    const changed = await m.changes.since(built);
    if (changed === undefined) return "history";
    if ([...cited].some((path) => changed.has(path))) return "changed";
  }
  return undefined;
}
