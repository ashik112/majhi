import {
  type CommitSha,
  WIKI_GAPS_HEADINGS,
  WIKI_RULES,
  type WikiDroppedClaim,
  type WikiDropReason,
  type WikiPage,
  type WikiPageId,
  WikiPageSchema,
  wikiPageId,
} from "@majhi/shared";
import type { CouldNot } from "./draft.ts";

export interface GapsInput {
  org: string;
  project: string;
  commit: CommitSha;
  /** The checked pages of this project. */
  pages: readonly WikiPage[];
  /** What the writer could not settle, per page it came from. */
  couldNot: readonly (CouldNot & { page: WikiPageId })[];
  /** Pages the writer gave no usable answer for. */
  failed: readonly { page: WikiPageId; problem: string }[];
}

const WHY: Record<WikiDropReason, string> = {
  "missing-file": "the file is not in the repo",
  "bad-range": "the lines do not exist",
  "text-changed": "the lines have changed",
  "outside-export": "the path is not a file inside the repo",
  "no-source": "it cited nothing",
};

const place = (d: WikiDroppedClaim): string =>
  d.cited.length === 0
    ? ""
    : ` Cited ${d.cited.map((c) => `\`${c.path}:${c.lines[0]}-${c.lines[1]}\``).join(", ")}.`;

/**
 * The Gaps page, made without a model from what the other pages could not stand behind: claims the checker
 * dropped ("Could not confirm"), claims that are guesses, what the writer could not work out, and pages it
 * could not write. Every list is left out when empty.
 */
export function buildGapsPage(input: GapsInput): WikiPage {
  const dropped = input.pages.flatMap((p) => p.dropped.map((d) => ({ d, page: p.title })));
  const guessed = input.pages.flatMap((p) =>
    p.claims.filter((c) => !c.proven).map((c) => ({ c, page: p.title })),
  );
  const sections: string[] = [];
  const add = (heading: string, lines: string[]) => {
    if (lines.length > 0) sections.push(`## ${heading}\n\n${lines.join("\n")}`);
  };
  add(
    WIKI_GAPS_HEADINGS.couldNotConfirm,
    dropped.map(({ d, page }) => `- ${d.text} (${page}): ${WHY[d.reason]}.${place(d)}`),
  );
  add(
    WIKI_GAPS_HEADINGS.guessed,
    guessed.map(({ c, page }) => `- ${c.text} (${page})`),
  );
  add(
    "Could not work out",
    input.couldNot.map((c) => `- ${c.topic}: ${c.why}`),
  );
  add(
    "Pages not written",
    input.failed.map((f) => `- ${f.page}: ${f.problem}`),
  );

  const found = dropped.length + guessed.length + input.couldNot.length + input.failed.length;
  const summary =
    found === 0
      ? "Nothing to report: every claim was confirmed in the code."
      : "What the wiki could not stand behind, so you can see where it is thin.";
  return WikiPageSchema.parse({
    id: wikiPageId({ kind: "gaps" }),
    org: input.org,
    project: input.project,
    kind: "gaps",
    title: "Gaps",
    body: [summary, ...sections].join("\n\n"),
    claims: [],
    roles: [],
    dropped: dropped.map((x) => x.d).slice(0, 400),
    diagrams: [],
    builtFrom: { [input.project]: input.commit },
    v: WIKI_RULES,
  });
}
