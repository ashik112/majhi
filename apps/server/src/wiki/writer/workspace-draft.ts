import type { WikiFactId, WikiPageId } from "@majhi/shared";
import { wikiPageId } from "@majhi/shared";
import type { CouldNot, DraftClaim, DraftPage, DraftRole, RawCitation } from "./draft.ts";

/**
 * A page of the workspace's wiki the plan asks the writer for: how its projects connect, and the cross-repo flows.
 * The Gaps page is built by code, and the picture on the overview is drawn from the links, not by the model.
 */
export type WorkspaceWriterPage =
  | { kind: "overview" }
  /** `trigger`: where it starts, in plain words. `facts`: the call facts of the links it starts from. */
  | { kind: "flow"; slug: string; title: string; trigger: string; facts: readonly WikiFactId[] };

export function workspacePageId(page: WorkspaceWriterPage): WikiPageId {
  return page.kind === "flow"
    ? wikiPageId({ kind: "flow", slug: page.slug })
    : wikiPageId({ kind: "overview" });
}

/** A place the writer cited: the repo it is in, then the path and lines inside that repo. */
export interface RepoCitation extends RawCitation {
  repo: string;
}

export interface WorkspaceDraftClaim extends DraftClaim {
  citations: readonly RepoCitation[];
}

/** A connection the writer believes exists but no exact match shows. Drawn dashed and listed as a guess. */
export interface GuessedLink {
  from: string;
  to: string;
  label?: string | undefined;
  why: string;
}

/** What the writer says about one workspace page, parsed but not checked. */
export interface WorkspaceDraft extends Pick<DraftPage, "id" | "title" | "summary"> {
  kind: "overview" | "flow";
  org: string;
  /** In order. A flow's are its steps; an overview's first claims are its project tiles. */
  claims: readonly WorkspaceDraftClaim[];
  /** Overview only: one tile per project, `where` is the project id. */
  roles: readonly DraftRole[];
  guessedLinks: readonly GuessedLink[];
  couldNot: readonly CouldNot[];
}

/** A project of the workspace as the writer sees it: where its export is mounted, and what its own overview says it is. */
export interface WorkspaceRepo {
  project: string;
  commit: string;
  /** The clean export of that commit, an absolute folder, mounted read-only. */
  root: string;
  /** What its overview found, one line each: `backend FastAPI (backend)`. */
  roles: readonly string[];
}
