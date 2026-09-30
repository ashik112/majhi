import { parseScope } from "@majhi/shared";
import { REPO_DOCS } from "./curator.ts";
import { CLEANUP_DOC_COSINE, type RepoDocs } from "./repo-docs.ts";
import type { MemoryService } from "./service.ts";

/** Set in `memory_meta` once the cleanup ran with the embedding model. */
export const CLEANUP_KEY = "cleanup:repo-docs:v1";

export interface CleanupDeps {
  memory: MemoryService;
  repoDocs: RepoDocs;
  /** Every registered project: its checkout and its org. */
  projects: () => Promise<{ id: string; path: string; org: string }[]>;
}

/**
 * One-time cleanup of the old one-line facts: a pending fact that is near-identical to a chunk of
 * a repo's CLAUDE.md, AGENTS.md or README is rejected with the reason "Already in the repo docs",
 * as a logged curation step that Undo reverses. Nothing is deleted, and other facts are left as
 * they are. A project fact is checked against its repo; an org fact against the org's repos; a
 * global fact against every repo. Runs until it has run once with the embedding model; before
 * that, only facts whose words are nearly all in one chunk are rejected. Resolves how many it rejected.
 */
export async function cleanupRepoDocFacts(deps: CleanupDeps): Promise<number> {
  const { memory, repoDocs } = deps;
  if (memory.project.meta(CLEANUP_KEY) !== undefined) return 0;
  const pending = memory.list({ status: "pending", limit: 10_000 });
  const withModel = pending.length === 0 || (await memory.embed(["probe"])) !== undefined;
  const projects = await deps.projects();
  let rejected = 0;
  for (const fact of pending) {
    const scope = parseScope(fact.scope);
    const paths = projects
      .filter((p) =>
        scope === undefined || scope.kind === "global"
          ? true
          : scope.kind === "org"
            ? p.org === scope.id
            : p.id === scope.id,
      )
      .map((p) => p.path);
    if (paths.length === 0) continue;
    const match = await repoDocs.match(fact.text, await repoDocs.chunks(paths), CLEANUP_DOC_COSINE);
    if (match === undefined) continue;
    const current = memory.get(fact.id);
    if (current?.status !== "pending") continue;
    memory.drop(fact.id, {
      reason: `Already in the repo docs (${match.chunk.file}): "${match.chunk.text.slice(0, 160)}".`,
      confidence: Math.min(1, match.similarity),
      provider: REPO_DOCS,
    });
    rejected += 1;
  }
  if (withModel)
    memory.project.setMeta(CLEANUP_KEY, JSON.stringify({ at: new Date().toISOString(), rejected }));
  if (rejected > 0) {
    console.log(
      `Memory: ${rejected} pending fact${rejected === 1 ? "" : "s"} already in the repo docs, rejected (Undo in the log).`,
    );
    memory.changed();
  }
  return rejected;
}
