import {
  type CommitSha,
  WIKI_RULES,
  type WikiFact,
  type WikiPage,
  WikiPageSchema,
  wikiPageId,
} from "@majhi/shared";

/** What the Deploys page says when the tools found no file that shows how the project deploys. */
export const NO_DEPLOY_FILES =
  "No deploy files were found in this project: no CI workflow or pipeline, no host config, no Dockerfile, no chart, no deploy script and no deploy document. Nothing is written here that the code does not show. If the project deploys some other way, add a note to this page and it will show here.";

/** Whether the facts include a file that shows how the project deploys. */
export function hasDeployFiles(facts: readonly WikiFact[]): boolean {
  return facts.some((f) => f.kind === "deploy");
}

/**
 * The Deploys page of a project with no deploy files, made by code: no model is asked, so nothing is invented and
 * nothing is spent. It has no claims and cites nothing. A deploy file that appears later makes the next update write it.
 */
export function deploysNotFound(org: string, project: string, commit: CommitSha): WikiPage {
  return WikiPageSchema.parse({
    id: wikiPageId({ kind: "deploys" }),
    org,
    project,
    kind: "deploys",
    title: "Deploys",
    body: NO_DEPLOY_FILES,
    claims: [],
    builtFrom: { [project]: commit },
    v: WIKI_RULES,
  });
}
