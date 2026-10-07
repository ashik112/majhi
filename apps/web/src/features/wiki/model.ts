import {
  type DiagramEdge,
  type DiagramNode,
  type DiagramSpec,
  WIKI_OWNER_NOTES_HEADING,
  type WikiClaim,
  type WikiDropReason,
  WikiFactIdSchema,
  type WikiPage,
  type WikiPageId,
  type WikiPageKind,
  type WikiPageSummary,
  type WikiRole,
  type WikiRoleRow,
  type WikiSource,
  type WikiSystemView,
} from "@majhi/shared";
import { COPY } from "./copy";

/** The list's groups, in order, with the name each shows. A workspace has no components or infra. */
export function groupsOf(workspace: boolean): readonly { kind: WikiPageKind; label: string }[] {
  return workspace
    ? [
        { kind: "overview", label: COPY.group.overview },
        { kind: "flow", label: COPY.group.crossRepoFlow },
        { kind: "gaps", label: COPY.group.gaps },
      ]
    : [
        { kind: "overview", label: COPY.group.overview },
        { kind: "component", label: COPY.group.component },
        { kind: "flow", label: COPY.group.flow },
        { kind: "infra", label: COPY.group.infra },
        { kind: "deploys", label: COPY.group.deploys },
        { kind: "gaps", label: COPY.group.gaps },
      ];
}

/** The small tag after a page's title. */
export function tagOf(kind: WikiPageKind, workspace: boolean): string {
  if (workspace) {
    return kind === "overview"
      ? COPY.tag.workspaceOverview
      : kind === "flow"
        ? COPY.tag.crossRepoFlow
        : COPY.tag[kind];
  }
  return COPY.tag[kind];
}

/** The word a role tile shows. */
export const ROLE_LABEL: Record<WikiRole, string> = {
  frontend: "Frontend",
  backend: "Backend",
  worker: "Workers",
  queue: "Queue",
  cache: "Cache",
  database: "Database",
  auth: "Sign-in",
  outside: "Outside",
  library: "Library",
  infra: "Infra",
  unknown: "Unknown",
};

/** The tone of a role's badge: what runs in the browser and the server in blue, what holds data in green. */
export const ROLE_TONE: Record<WikiRole, "neutral" | "blue" | "green"> = {
  frontend: "blue",
  backend: "blue",
  worker: "neutral",
  queue: "neutral",
  cache: "green",
  database: "green",
  auth: "blue",
  outside: "neutral",
  library: "neutral",
  infra: "neutral",
  unknown: "neutral",
};

/** The roles an overview should answer for. One with no tile is listed as not found. */
export const CORE_ROLES: readonly WikiRole[] = [
  "frontend",
  "backend",
  "worker",
  "queue",
  "cache",
  "database",
  "auth",
];

export const DROP_WORDS: Record<WikiDropReason, string> = {
  "missing-file": "The file is not in the code.",
  "bad-range": "The lines are outside the file.",
  "text-changed": "The cited lines are not what the claim says.",
  "outside-export": "The path is outside the project.",
  "no-source": "No source was given.",
};

/** Every source a page cites, once each (a path and its lines), in the order the claims come. */
export function sourcesOf(page: WikiPage): WikiSource[] {
  const seen = new Set<string>();
  const out: WikiSource[] = [];
  for (const claim of page.claims) {
    for (const s of claim.sources) {
      const key = `${s.path}:${s.lines[0]}-${s.lines[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

/** The files a page cites that a newer commit changed. Empty when nothing is known to have moved. */
export function movedFiles(page: WikiPage, changed: ReadonlySet<string>): string[] {
  if (changed.size === 0) return [];
  return [...new Set(sourcesOf(page).map((s) => s.path))].filter((path) => changed.has(path));
}

export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The folder a page is about: where its first cited file sits. Absent when it cites nothing. */
export function folderOf(page: WikiPage): string | undefined {
  const first = sourcesOf(page)[0];
  if (first === undefined) return undefined;
  const parts = first.path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : first.path;
}

/** A flow's steps are its claims in order. */
export function countClaims(claims: readonly WikiClaim[]): {
  total: number;
  proven: number;
  guessed: number;
} {
  const proven = claims.filter((c) => c.proven).length;
  return { total: claims.length, proven, guessed: claims.length - proven };
}

/** What the list says under a page's title. */
export function subline(page: WikiPage): string {
  switch (page.kind) {
    case "overview":
      return page.project === undefined
        ? COPY.subline.workspaceOverview(
            page.diagrams[0]?.nodes.length ?? 0,
            page.diagrams[0]?.edges.length ?? 0,
          )
        : COPY.subline.overview;
    case "component":
      return folderOf(page) ?? COPY.tag.component;
    case "flow": {
      const n = countClaims(page.claims);
      return `${n.total} step${n.total === 1 ? "" : "s"}, ${n.proven} proven`;
    }
    case "infra":
      return COPY.subline.infra;
    case "deploys":
      return COPY.subline.deploys;
    case "gaps":
      return COPY.subline.gaps;
  }
}

/** Whether a line is drawn as a guess. A writer's older pages used a dashed style for it. */
export function isGuessed(edge: Pick<DiagramEdge, "style">): boolean {
  return edge.style === "dotted" || edge.style === "dashed";
}

/** The page title a diagram box stands for, when the box is one of this scope's component pages. */
export interface PageRef {
  id: WikiPageId;
  title: string;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The component page a box of a diagram is, by its id (the page's slug) or by its name. */
export function pageOfNode(node: DiagramNode, pages: readonly WikiPageSummary[]): PageRef | undefined {
  const hit = pages.find(
    (p) =>
      p.kind === "component" && (p.id.slice("component:".length) === node.id || same(p.title, node.label)),
  );
  return hit === undefined ? undefined : { id: hit.id, title: hit.title };
}

/** One line of a component's "Talks to": a line of its diagram that starts or ends at it. */
export interface TalkRow {
  key: string;
  type: DiagramEdge["type"];
  /** The line ends at this component: the arrow points at it. */
  incoming: boolean;
  both: boolean;
  /** The box at the other end, and its page when it is a component page. */
  other: { label: string; page: PageRef | undefined };
  label: string | undefined;
  proven: boolean;
}

function selfNode(spec: DiagramSpec, page: WikiPage): DiagramNode | undefined {
  const slug = page.id.slice(page.id.indexOf(":") + 1);
  return (
    spec.nodes.find((n) => n.id === spec.focus) ??
    spec.nodes.find((n) => n.id === slug) ??
    spec.nodes.find((n) => same(n.label, page.title))
  );
}

/** What a component talks to, from the lines of its own diagram. */
export function talksTo(page: WikiPage, pages: readonly WikiPageSummary[]): TalkRow[] {
  const rows: TalkRow[] = [];
  for (const spec of page.diagrams) {
    const me = selfNode(spec, page);
    if (me === undefined || spec.layout === "sequence") continue;
    spec.edges.forEach((e, i) => {
      if (e.from !== me.id && e.to !== me.id) return;
      if (e.from === e.to) return;
      const other = spec.nodes.find((n) => n.id === (e.from === me.id ? e.to : e.from));
      if (other === undefined) return;
      rows.push({
        key: `${spec.title}:${i}`,
        type: e.type,
        incoming: e.to === me.id && e.arrow !== "both",
        both: e.arrow === "both",
        other: { label: other.label, page: pageOfNode(other, pages) },
        label: e.label,
        proven: !isGuessed(e),
      });
    });
  }
  return rows;
}

/** The flow pages whose steps cite a file inside the folder of a component. */
export function flowsUsing(page: WikiPage, flows: readonly { summary: WikiPageSummary; page: WikiPage }[]) {
  const folder = folderOf(page);
  if (folder === undefined) return [];
  return flows.filter(
    ({ page: f }) =>
      f.kind === "flow" && f.claims.some((c) => c.sources.some((s) => s.path.startsWith(`${folder}/`))),
  );
}

/** The overview's role row that names this component page: its role, technology and place. */
export function roleRowOf(id: WikiPageId, overview: WikiPage | undefined): WikiRoleRow | undefined {
  return overview?.roles.find((r) => r.page === id);
}

/** A unit the infra page lists: the name its fact carries, and the claim that shows it. */
export function unitName(claim: WikiClaim): string | undefined {
  for (const id of claim.facts) {
    const parsed = WikiFactIdSchema.safeParse(id);
    if (!parsed.success) continue;
    const [, kind, ...slug] = parsed.data.split(":");
    if (kind === "unit" || kind === "store") return slug.join(":");
  }
  return undefined;
}

/** One thing the gaps view lists: a guess a page makes. */
export interface GuessedClaim {
  page: WikiPageSummary;
  claim: WikiClaim;
}

/** One claim the checker dropped, with the page it came from. */
export interface DroppedItem {
  page: WikiPageSummary;
  text: string;
  reason: WikiDropReason;
  cited: readonly { path: string; lines: readonly [number, number] }[];
}

/** Everything that needs a look across a scope's pages: the guesses and the claims the checker dropped. */
export function openItems(pages: readonly { summary: WikiPageSummary; page: WikiPage }[]): {
  guessed: GuessedClaim[];
  dropped: DroppedItem[];
} {
  const guessed: GuessedClaim[] = [];
  const dropped: DroppedItem[] = [];
  for (const { summary, page } of pages) {
    for (const claim of page.claims) if (!claim.proven) guessed.push({ page: summary, claim });
    for (const d of page.dropped)
      dropped.push({ page: summary, text: d.text, reason: d.reason, cited: d.cited });
  }
  return { guessed, dropped };
}

/**
 * The opening of a page's body: what comes before its first heading. The writer follows the opening with the
 * claims as a list, which a component or infra page shows as its own details, so it shows the opening only.
 */
export function leadOf(body: string): string {
  return body.split("\n\n## ")[0] ?? "";
}

/** The page without its "Owner notes" section: the notes are drawn from the data, with a way to drop each. */
export function withoutNotes(page: WikiPage): WikiPage {
  const [lead = "", ...sections] = page.body.split("\n\n## ");
  const kept = sections.filter((s) => s.split("\n")[0]?.trim() !== WIKI_OWNER_NOTES_HEADING);
  return kept.length === sections.length ? page : { ...page, body: [lead, ...kept].join("\n\n## ") };
}

/** How many things on the Gaps page need a look: guesses, claims the checker dropped, calls that link nowhere and open questions. */
export function gapCount(
  pages: readonly { summary: WikiPageSummary; page: WikiPage }[],
  system: Pick<WikiSystemView, "unlinked" | "questions"> | undefined,
  project: string | undefined,
): number {
  const { guessed, dropped } = openItems(pages);
  const overview = pages.find((p) => p.page.kind === "overview")?.page;
  const roleClaims = new Set(overview?.roles.map((r) => r.claim) ?? []);
  const loose = guessed.filter((g) => !(g.page.id === overview?.id && roleClaims.has(g.claim.n)));
  const unlinked = (system?.unlinked ?? []).filter((u) => project === undefined || u.project === project);
  const questions = (system?.questions ?? []).filter(
    (q) => project === undefined || q.projects.includes(project),
  );
  const rows =
    project === undefined
      ? 0
      : (overview?.roles ?? []).filter(
          (r) => r.basis !== "owner" && overview?.claims.find((c) => c.n === r.claim)?.proven === false,
        ).length;
  return loose.length + dropped.length + unlinked.length + questions.length + rows;
}
