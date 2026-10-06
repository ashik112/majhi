import {
  type CommitSha,
  type DiagramSpec,
  DiagramSpecSchema,
  WIKI_GAPS_HEADINGS,
  WIKI_RULES,
  type WikiDroppedClaim,
  type WikiFactBasis,
  type WikiPage,
  type WikiPageId,
  WikiPageSchema,
  type WikiRoleRow,
  type WikiSystemView,
  wikiPageId,
} from "@majhi/shared";
import type { Housekeeper } from "../../memory/housekeeper.ts";
import { ExportReader } from "../source.ts";
import { pairLinks } from "../system/links.ts";
import { type CitationCheck, checkCitation, checkClaim, settle } from "./check.ts";
import type { CouldNot } from "./draft.ts";
import { unlinkedLine } from "./gaps.ts";
import { bodyOf, diagramsOf } from "./render.ts";
import type { RepoCitation, WorkspaceDraft, WorkspaceRepo, WorkspaceWriterPage } from "./workspace-draft.ts";
import { workspacePageId } from "./workspace-draft.ts";
import { linkHints, workspacePagePrompt } from "./workspace-prompt.ts";
import { parseWorkspaceReply } from "./workspace-reply.ts";
import { askPages, type WriteOutcome, wikiSpendId } from "./write.ts";

export interface WriteWorkspaceInput {
  housekeeper: Pick<Housekeeper, "session">;
  org: string;
  /** Every project of the workspace that has facts: its export is mounted read-only. At least one. */
  repos: readonly [WorkspaceRepo, ...WorkspaceRepo[]];
  system: Pick<WikiSystemView, "links">;
  pages: readonly WorkspaceWriterPage[];
  capUsd?: number | undefined;
  capTokens?: number | undefined;
  stop?: (() => Promise<string | undefined>) | undefined;
  progress?: ((done: number, total: number) => void) | undefined;
}

/**
 * Writes the workspace's pages in one read-only session of the Housekeeper with every project's export mounted
 * read-only. Each page's hints are the links that tools proved, and a claim cites `{repo, path, lines}`.
 */
export function writeWorkspacePages(input: WriteWorkspaceInput): Promise<WriteOutcome<WorkspaceDraft>> {
  const [first, ...others] = input.repos;
  const projects = new Set(input.repos.map((r) => r.project));
  return askPages<WorkspaceWriterPage, WorkspaceDraft>({
    housekeeper: input.housekeeper,
    task: { id: wikiSpendId(input.org, undefined), org: input.org },
    mode: { kind: "repo", root: first.root, also: others.map((r) => r.root) },
    pages: input.pages,
    job: {
      id: workspacePageId,
      prompt: (page, firstPage) =>
        workspacePagePrompt({
          org: input.org,
          repos: input.repos,
          page,
          links: linkHints(page, input.system.links).text,
          first: firstPage,
        }),
      parse: (page) => parseWorkspaceReply(page, { org: input.org, projects }),
    },
    capUsd: input.capUsd,
    capTokens: input.capTokens,
    stop: input.stop,
    progress: input.progress,
  });
}

/**
 * Step 5 for a workspace page: every citation is looked at in the export of the repo it names and only there, so a
 * path that is fine in one repo never proves a claim about another, and a repo the workspace does not have proves
 * nothing. The page is built from the commit each repo was read at.
 */
export async function checkWorkspacePage(
  draft: WorkspaceDraft,
  repos: readonly Pick<WorkspaceRepo, "project" | "commit" | "root">[],
  system: Pick<WikiSystemView, "links">,
  org: string,
): Promise<WikiPage> {
  const readers = new Map(
    repos.map((r) => [
      r.project,
      { files: new ExportReader(r.root), at: { repo: r.project, commit: r.commit as CommitSha } },
    ]),
  );
  const check = (c: RepoCitation): Promise<CitationCheck> => {
    const reader = readers.get(c.repo);
    return reader === undefined
      ? Promise.resolve({ ok: false, reason: "outside-export" })
      : checkCitation(reader.files, c, reader.at);
  };
  const checked = await Promise.all(draft.claims.map((c) => checkClaim(c, check)));
  const { kept, dropped, roles, tiles } = settle(checked, draft.roles);
  const diagrams =
    draft.kind === "flow"
      ? diagramsOf({ kind: "flow", title: draft.title, claims: draft.claims }, kept)
      : [
          workspaceDiagram(
            repos.map((r) => r.project),
            roles,
            system,
            draft.guessedLinks,
          ),
        ];
  return WikiPageSchema.parse({
    id: draft.id,
    org,
    kind: draft.kind,
    title: draft.title.slice(0, 120),
    body: bodyOf(draft, kept, draft.summary, tiles),
    claims: kept.map((k) => k.claim),
    roles,
    dropped,
    diagrams,
    builtFrom: Object.fromEntries(repos.map((r) => [r.project, r.commit])),
    v: WIKI_RULES,
  });
}

/** How a link is known, in the words under its label on the picture. */
const BASIS_NOTE: Record<WikiFactBasis, string> = {
  declared: "declared",
  exact: "exact route match",
  config: "set by config",
  owner: "your answer",
};

const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The picture of the workspace, drawn from the links and never by the model: a box per project (its role and what it
 * is, from the tile the writer gave and the checker kept), a line per pair of projects and type, solid, named by the
 * strongest link and how it is known. A guess the writer made is dotted. Without a tile a box has no role tag.
 */
export function workspaceDiagram(
  projects: readonly string[],
  tiles: readonly WikiRoleRow[],
  system: Pick<WikiSystemView, "links">,
  guessed: readonly { from: string; to: string; label?: string | undefined }[],
): DiagramSpec {
  const known = new Set(projects);
  const edges = pairLinks(system.links)
    .filter((l) => known.has(l.from) && known.has(l.to))
    .map((l) => ({
      from: l.from,
      to: l.to,
      type: l.type,
      label: cut(`${l.label}${l.count > 1 ? ` +${l.count - 1}` : ""}`, 60),
      note: BASIS_NOTE[l.basis],
    }));
  const drawn = new Set(edges.map((e) => `${e.from}>${e.to}`));
  const dashed = guessed
    .filter((g) => known.has(g.from) && known.has(g.to) && !drawn.has(`${g.from}>${g.to}`))
    .map((g) => ({
      from: g.from,
      to: g.to,
      style: "dotted" as const,
      label: cut(g.label ?? "linked", 60),
      note: "guessed",
    }));
  return DiagramSpecSchema.parse({
    title: "How the projects connect",
    layout: "flow",
    nodes: [...projects].toSorted().map((id) => {
      const tile = tiles.find((t) => t.where === id);
      return {
        id,
        label: cut(id, 60),
        kind: tile?.role ?? "project",
        ...(tile === undefined ? {} : { sub: cut(tile.tech, 120) }),
      };
    }),
    edges: [...edges, ...dashed],
  });
}

export interface WorkspaceGapsInput {
  org: string;
  /** The commit each project was read at. */
  builtFrom: Record<string, CommitSha>;
  /** The workspace pages as checked. */
  pages: readonly WikiPage[];
  system: WikiSystemView;
  couldNot: readonly (CouldNot & { page: WikiPageId })[];
  failed: readonly { page: WikiPageId; problem: string }[];
}

const address = (q: { host: string; port?: number | undefined }) =>
  `${q.host}${q.port === undefined ? "" : `:${q.port}`}`;

/**
 * The workspace's Gaps page, made without a model: calls that match no route (with file:line), the addresses nobody
 * placed (questions for the owner), links the writer only guessed, projects with no facts yet, and the claims the
 * checker could not confirm. Every list is left out when empty.
 */
export function buildWorkspaceGapsPage(input: WorkspaceGapsInput): WikiPage {
  const dropped: { d: WikiDroppedClaim; page: string }[] = input.pages.flatMap((p) =>
    p.dropped.map((d) => ({ d, page: p.title })),
  );
  const guessedClaims = input.pages.flatMap((p) =>
    p.claims.filter((c) => !c.proven).map((c) => ({ c, page: p.title })),
  );
  const guessedLinks = input.pages.flatMap((p) =>
    p.diagrams.flatMap((d) =>
      d.edges
        .filter((e) => e.style === "dotted" && p.kind === "overview")
        .map((e) => `- ${e.from} to ${e.to}: ${e.label ?? "linked"}`),
    ),
  );
  const sections: string[] = [];
  const add = (heading: string, lines: string[]) => {
    if (lines.length > 0) sections.push(`## ${heading}\n\n${lines.join("\n")}`);
  };
  add(
    WIKI_GAPS_HEADINGS.notLinked,
    input.system.unlinked.map((u) => unlinkedLine(u, true)),
  );
  add(
    WIKI_GAPS_HEADINGS.questions,
    input.system.questions.map(
      (q) =>
        `- What is \`${address(q)}\`${q.scope === undefined ? "" : ` (a local address in ${q.scope})`}? Called by ${q.projects.join(", ")}${q.keys.length === 0 ? "" : `, set in ${q.keys.join(", ")}`}.`,
    ),
  );
  add("Guessed links", guessedLinks);
  add(
    "Could not confirm",
    dropped.map(({ d, page }) => `- ${d.text} (${page})`),
  );
  add(
    "Guessed",
    guessedClaims.map(({ c, page }) => `- ${c.text} (${page})`),
  );
  add(
    "Could not work out",
    input.couldNot.map((c) => `- ${c.topic}: ${c.why}`),
  );
  add(
    "Pages not written",
    input.failed.map((f) => `- ${f.page}: ${f.problem}`),
  );
  add(
    "Not read yet",
    input.system.missing.map((p) => `- ${p}: no facts yet, so nothing links to or from it. Update it first.`),
  );
  const found =
    input.system.unlinked.length +
    input.system.questions.length +
    guessedLinks.length +
    dropped.length +
    guessedClaims.length +
    input.couldNot.length +
    input.failed.length +
    input.system.missing.length;
  const summary =
    found === 0
      ? "Nothing to report: every call is linked and every claim was confirmed in the code."
      : "What the wiki could not stand behind across the projects, so you can see where it is thin.";
  return WikiPageSchema.parse({
    id: wikiPageId({ kind: "gaps" }),
    org: input.org,
    kind: "gaps",
    title: "Gaps",
    body: [summary, ...sections].join("\n\n"),
    claims: [],
    roles: [],
    dropped: dropped.map((x) => x.d).slice(0, 400),
    diagrams: [],
    builtFrom: input.builtFrom,
    v: WIKI_RULES,
  });
}
