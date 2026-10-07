import type { Remote, Repo, RootScan } from "@majhi/shared";
import { HOST_LABEL } from "../../lib/hosts";

/** The remote a repo row shows: `origin` when present, else the first one. */
export function primaryRemote(repo: Repo): Remote | undefined {
  return repo.remotes.find((r) => r.name === "origin") ?? repo.remotes[0];
}

/** Lowercased, whitespace-separated search terms. Every term must match (AND). */
export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function repoMatches(repo: Repo, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const fields = [repo.name, repo.relPath, repo.path, repo.branch ?? ""];
  for (const remote of repo.remotes) {
    fields.push(remote.url, remote.host, HOST_LABEL[remote.host]);
  }
  const haystack = fields.join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Keeps each root's matching repos. With no terms every root is returned as is, including
 * empty and unmounted ones; with terms, roots without a match are dropped.
 */
export function filterRoots(roots: readonly RootScan[], terms: readonly string[]): RootScan[] {
  if (terms.length === 0) return [...roots];
  return roots
    .map((root) => ({ ...root, repos: root.repos.filter((repo) => repoMatches(repo, terms)) }))
    .filter((root) => root.repos.length > 0);
}

export interface TextPart {
  text: string;
  match: boolean;
}

/** Splits `text` into parts, marking every case-insensitive occurrence of any term. */
export function highlightParts(text: string, terms: readonly string[]): TextPart[] {
  if (terms.length === 0 || text === "") return [{ text, match: false }];
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    let from = lower.indexOf(term);
    while (from !== -1) {
      marked.fill(true, from, from + term.length);
      from = lower.indexOf(term, from + 1);
    }
  }

  const parts: TextPart[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start]) {
      parts.push({ text: text.slice(start, i), match: marked[start] === true });
      start = i;
    }
  }
  return parts;
}
