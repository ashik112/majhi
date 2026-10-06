import type { CommitSha, WikiFactId, WikiKnownRole, WikiPageId, WikiPageKind } from "@majhi/shared";
import { wikiPageId } from "@majhi/shared";

/**
 * A page the plan asks the writer for. The Gaps page is not here: it is built from what the other pages
 * could not confirm, never written by the model.
 */
export type WriterPage =
  | { kind: "overview" }
  | { kind: "infra" }
  /** `folder`: where the component lives. `facts`: the tool facts the plan starts from. */
  | { kind: "component"; slug: string; title: string; folder: string; facts: readonly WikiFactId[] }
  /** `trigger`: where it starts, in plain words, like "a person signs in on the web console". */
  | { kind: "flow"; slug: string; title: string; trigger: string; facts: readonly WikiFactId[] };

export function writerPageId(page: WriterPage): WikiPageId {
  return page.kind === "component" || page.kind === "flow"
    ? wikiPageId({ kind: page.kind, slug: page.slug })
    : wikiPageId({ kind: page.kind });
}

/** A place the writer cited, before the checker has looked. The path may be anything the model wrote. */
export interface RawCitation {
  path: string;
  lines: readonly [number, number];
}

/** One sentence of a page with what the writer says backs it. Not yet checked. */
export interface DraftClaim {
  text: string;
  /** What the writer says: the cited lines show it directly (`proven`) or it inferred it. */
  proven: boolean;
  citations: readonly RawCitation[];
  facts: readonly WikiFactId[];
  /** Flow steps: who does it ("Browser", "API", "Worker"). Draws the sequence diagram. */
  actor?: string | undefined;
  /** Flow steps: the arrow's label in the sequence diagram, a few words. */
  label?: string | undefined;
}

/** A tile of an overview: the role, where it lives and its technology, backed by the claim at `claim` (an index into `claims`). */
export interface DraftRole {
  role: WikiKnownRole;
  where: string;
  tech: string;
  claim: number;
}

/** A box-and-lines picture of a non-flow page. A line is solid only when the claim it names is proven. */
export interface DraftDiagram {
  title: string;
  nodes: readonly {
    id: string;
    label: string;
    sub?: string | undefined;
    /** What the box is: draws its colored tag. */
    role?: WikiKnownRole | undefined;
    /** The row the box is drawn in: boxes of one tier share a row. */
    rank?: number | undefined;
  }[];
  edges: readonly {
    from: string;
    to: string;
    label?: string | undefined;
    /** How the two talk: draws the line's color. */
    type?: "http" | "queue" | "data" | undefined;
    claim?: number | undefined;
  }[];
}

/** What the writer could not settle, and why. It goes to the Gaps page. */
export interface CouldNot {
  topic: string;
  why: string;
}

/** What the writer says about one page, parsed but not checked: the claims have no hash and may cite nothing real. */
export interface DraftPage {
  id: WikiPageId;
  kind: Exclude<WikiPageKind, "gaps">;
  org: string;
  project: string;
  commit: CommitSha;
  title: string;
  /** The opening sentences. */
  summary: readonly string[];
  /** In order. A flow's are its steps. */
  claims: readonly DraftClaim[];
  /** Overview only. */
  roles: readonly DraftRole[];
  diagram?: DraftDiagram | undefined;
  couldNot: readonly CouldNot[];
}
