import type {
  WikiClaim,
  WikiDropReason,
  WikiPage,
  WikiPageKind,
  WikiPageSummary,
  WikiRole,
  WikiSource,
} from "@majhi/shared";

/** The list's groups, in order, with the name each shows. */
export const GROUPS: readonly { kind: WikiPageKind; label: string }[] = [
  { kind: "overview", label: "Overview" },
  { kind: "component", label: "Components" },
  { kind: "flow", label: "Flows" },
  { kind: "infra", label: "Infra and deploy" },
  { kind: "gaps", label: "Gaps" },
];

/** The small tag after a page's title. */
export const KIND_TAG: Record<WikiPageKind, string> = {
  overview: "Project",
  component: "Component",
  flow: "Flow",
  infra: "Infra",
  gaps: "Gaps",
};

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
      return "What it is, roles, map";
    case "component":
      return folderOf(page) ?? "Component";
    case "flow": {
      const n = countClaims(page.claims);
      return `${n.total} step${n.total === 1 ? "" : "s"}, ${n.proven} proven`;
    }
    case "infra":
      return "Hosts and deploy";
    case "gaps":
      return "To check";
  }
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
