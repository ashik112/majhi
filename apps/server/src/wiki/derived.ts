import { type CommitSha, type WikiPage, type WikiSystemView, wikiPageId } from "@majhi/shared";
import type { WikiGaps, WikiRepo } from "./repo.ts";
import { guessedRoles } from "./roles.ts";
import { buildGapsPage } from "./writer/gaps.ts";

/**
 * Pages made by code from what is stored, with no model: a project's Gaps page and the workspace's. They are made
 * again whenever what they show may have changed (a project updated, an answer given, a role confirmed).
 */

/** Two gaps pages say the same when everything but the commit they were made at is equal. */
export function sameGaps(a: WikiPage, b: WikiPage): boolean {
  return a.body === b.body && JSON.stringify(a.dropped) === JSON.stringify(b.dropped) && a.v === b.v;
}

/**
 * A project's Gaps page: its claims that did not hold, its guesses (a role the owner decided is no longer one), the
 * roles still to confirm, and its calls that link to no other project. `gaps` is what the writer could not settle.
 */
export function projectGapsPage(
  repo: WikiRepo,
  input: { org: string; project: string; commit: CommitSha; view: WikiSystemView; gaps: WikiGaps },
): WikiPage {
  const { org, project } = input;
  const stored = repo.loaded(org, project).filter((p) => p.kind !== "gaps");
  const choices = repo.roleAnswers(org);
  const overview = stored.find((p) => p.id === wikiPageId({ kind: "overview" }));
  return buildGapsPage({
    org,
    project,
    commit: input.commit,
    pages: stored.map((p) => repo.shown(p)),
    couldNot: input.gaps.couldNot,
    failed: input.gaps.failed,
    guessedRoles: overview === undefined ? [] : guessedRoles(overview, choices),
    unlinked: input.view.unlinked.filter((u) => u.project === project),
  });
}

/** Saves the Gaps page of a project unless it says what the stored one says. True when it was saved. */
export function saveProjectGaps(repo: WikiRepo, page: WikiPage): boolean {
  const had = repo.page(page.org, page.project, page.id)?.page;
  if (had !== undefined && sameGaps(had, page)) return false;
  return repo.save(page);
}
