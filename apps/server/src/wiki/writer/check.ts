import {
  type CommitSha,
  WIKI_RULES,
  type WikiCitation,
  WikiCitationSchema,
  type WikiDroppedClaim,
  type WikiDropReason,
  type WikiFactId,
  type WikiPage,
  WikiPageSchema,
  type WikiRoleRow,
  type WikiSource,
} from "@majhi/shared";
import { ExportReader, hashLines } from "../source.ts";
import type { DraftPage, DraftRole, RawCitation } from "./draft.ts";
import { bodyOf, diagramsOf, type KeptClaim } from "./render.ts";

export type CitationCheck = { ok: true; source: WikiSource } | { ok: false; reason: WikiDropReason };

/** Where a citation points: which repo and commit the lines are read at. */
export interface CitedAt {
  repo: string;
  commit: CommitSha;
}

/**
 * Looks at one citation in the export: a path inside the repo that reaches a file inside the export, lines
 * that exist, and the hash of those lines, stored so a later change in them is seen.
 */
export async function checkCitation(
  files: ExportReader,
  c: RawCitation,
  at: CitedAt,
): Promise<CitationCheck> {
  const file = await files.file(c.path);
  if (!file.ok) return { ok: false, reason: file.reason };
  const [start, end] = c.lines;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 1 ||
    end < start ||
    end > file.lines.length
  ) {
    return { ok: false, reason: "bad-range" };
  }
  const cited = WikiCitationSchema.parse({ path: c.path, lines: [start, end] });
  return {
    ok: true,
    source: { ...cited, repo: at.repo, commit: at.commit, hash: hashLines(file.lines.slice(start - 1, end)) },
  };
}

/** A stored source against the export now: `ok`, or why it no longer holds (the file or lines moved, or the text changed). */
export async function verifySource(files: ExportReader, source: WikiSource): Promise<"ok" | WikiDropReason> {
  const now = await checkCitation(files, source, source);
  if (!now.ok) return now.reason;
  return now.source.hash === source.hash ? "ok" : "text-changed";
}

/** The citations of a dropped claim that can be written down: one with a path outside the repo has none to show. */
function showable(citations: readonly RawCitation[]): WikiCitation[] {
  return citations.flatMap((c) => {
    const parsed = WikiCitationSchema.safeParse({ path: c.path, lines: c.lines });
    return parsed.success ? [parsed.data] : [];
  });
}

/** A claim before it has its number. */
type Kept = { text: string; facts: WikiFactId[] } & (
  | { proven: true; sources: [WikiSource, ...WikiSource[]] }
  | { proven: false; sources: WikiSource[] }
);
export type ClaimCheck = { kept: Kept } | { dropped: WikiDroppedClaim };

/** What a claim has, whichever repo its citations point into. */
export interface ClaimToCheck<K extends RawCitation = RawCitation> {
  text: string;
  proven: boolean;
  facts: readonly WikiFactId[];
  citations: readonly K[];
}

/**
 * A proven claim keeps only if it cites something and every citation holds. A guess keeps with the
 * citations that hold, and may have none. `check` looks at one citation: against one repo's export for a project
 * page, against the export of the repo each citation names for a workspace page.
 */
export async function checkClaim<K extends RawCitation>(
  c: ClaimToCheck<K>,
  check: (citation: K) => Promise<CitationCheck>,
): Promise<ClaimCheck> {
  const checks = await Promise.all(c.citations.map(check));
  const sources = checks.flatMap((k) => (k.ok ? [k.source] : []));
  const failed = checks.flatMap((k) => (k.ok ? [] : [k.reason]));
  if (!c.proven) return { kept: { text: c.text, facts: [...c.facts], proven: false, sources } };
  const [first, ...others] = sources;
  const reason: WikiDropReason | undefined = failed[0] ?? (first === undefined ? "no-source" : undefined);
  if (first === undefined || reason !== undefined) {
    return { dropped: { text: c.text, reason: reason ?? "no-source", cited: showable(c.citations) } };
  }
  return { kept: { text: c.text, facts: [...c.facts], proven: true, sources: [first, ...others] } };
}

/** The claims that held, numbered from 1 in order, the ones that did not, and the role tiles whose claim held. */
export function settle(
  checked: readonly ClaimCheck[],
  draftRoles: readonly DraftRole[],
): { kept: KeptClaim[]; dropped: WikiDroppedClaim[]; roles: WikiRoleRow[]; tiles: Set<number> } {
  const kept: KeptClaim[] = [];
  const dropped: WikiDroppedClaim[] = [];
  const numberOf = new Map<number, number>();
  checked.forEach((result, index) => {
    if ("dropped" in result) {
      dropped.push(result.dropped);
      return;
    }
    const n = kept.length + 1;
    numberOf.set(index, n);
    kept.push({ at: index, claim: { ...result.kept, n } });
  });
  const roles: WikiRoleRow[] = draftRoles.flatMap((r) => {
    const claim = numberOf.get(r.claim);
    return claim === undefined ? [] : [{ role: r.role, where: r.where, tech: r.tech, claim }];
  });
  return { kept, dropped, roles, tiles: new Set(roles.map((r) => r.claim)) };
}

/**
 * Step 5 of the pipeline: confirms every claim of a draft against the export, drops the ones that do not
 * hold (listed on the page and on the Gaps page), numbers the rest from 1 in order, and makes the page.
 * Roles whose claim was dropped lose their tile. The result is a page that parses as a `WikiPage`.
 */
export async function checkPage(draft: DraftPage, exportDir: string): Promise<WikiPage> {
  const files = new ExportReader(exportDir);
  const at = { repo: draft.project, commit: draft.commit };
  const checked = await Promise.all(
    draft.claims.map((c) => checkClaim(c, (x) => checkCitation(files, x, at))),
  );
  const { kept, dropped, roles, tiles } = settle(checked, draft.roles);

  return WikiPageSchema.parse({
    id: draft.id,
    org: draft.org,
    project: draft.project,
    kind: draft.kind,
    title: draft.title.slice(0, 120),
    body: bodyOf(draft, kept, draft.summary, tiles),
    claims: kept.map((k) => k.claim),
    roles,
    dropped,
    diagrams: diagramsOf(draft, kept),
    builtFrom: { [draft.project]: draft.commit },
    v: WIKI_RULES,
  });
}
