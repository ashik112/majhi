import type { Fact, FactHit, FactStatus, MemoryScope } from "@majhi/shared";
import type { Embedder } from "./embedder.ts";
import type { MemoryStore } from "./store.ts";

/** How many candidates each of the keyword and the vector search contributes. */
export const CANDIDATES = 20;
/** The usual damping constant of reciprocal rank fusion. */
export const RRF_K = 60;

/** Fuses ranked id lists: each id scores the sum of 1 / (k + rank) over the lists it is in. */
export function fuse(lists: readonly (readonly number[])[], k = RRF_K): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const [i, id] of list.entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
  }
  return scores;
}

export interface SearchOptions {
  scopes: readonly MemoryScope[];
  status?: FactStatus;
  limit?: number;
}

export interface SearchResult {
  hits: FactHit[];
  /** The vector half did not run, so only keywords ranked the hits. */
  keywordOnly: boolean;
}

/**
 * Hybrid search (SPEC 5.6): the best 20 by bm25 and the best 20 by vector distance, fused by
 * reciprocal rank, in the allowed scopes only. Pinned facts come first, each group by score. With
 * no embedder, or when it fails, keywords rank alone.
 */
export async function hybridSearch(
  store: MemoryStore,
  embedder: Embedder | undefined,
  query: string,
  options: SearchOptions,
): Promise<SearchResult> {
  const status = options.status ?? "active";
  // Nothing to find: do not wake the model for it.
  if (store.count(options.scopes, status) === 0) return { hits: [], keywordOnly: false };
  const keyword = store.keywordIds(query, options.scopes, status, CANDIDATES);
  let nearest: number[] = [];
  let keywordOnly = true;
  if (embedder !== undefined && options.scopes.length > 0) {
    try {
      const [vector] = await embedder.embed([query]);
      if (vector !== undefined) {
        nearest = store.nearestIds(vector, options.scopes, status, CANDIDATES);
        keywordOnly = false;
      }
    } catch {
      // The model did not load: keywords still work, and vectors are filled in later.
    }
  }
  const scores = fuse([keyword, nearest]);
  const facts = new Map<number, Fact>(store.byIds([...scores.keys()]).map((f) => [f.id, f]));
  const hits = [...scores.entries()]
    .flatMap(([id, score]) => {
      const fact = facts.get(id);
      return fact === undefined ? [] : [{ fact, score }];
    })
    .sort(
      (a, b) => Number(b.fact.pinned) - Number(a.fact.pinned) || b.score - a.score || a.fact.id - b.fact.id,
    );
  return { hits: hits.slice(0, options.limit ?? CANDIDATES * 2), keywordOnly };
}
