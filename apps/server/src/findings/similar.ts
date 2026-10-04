/**
 * Telling two opportunity titles apart from two wordings of one idea. The captain writes a new
 * pitch each week; "Add a staging preview per pull request" and "Preview environments for each pull
 * request" are the same opportunity, and a dismissed one must not come back under a new title.
 */

const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "that",
  "this",
  "your",
  "their",
  "each",
  "per",
  "add",
  "offer",
  "build",
  "make",
  "new",
  "use",
  "using",
  "can",
  "could",
  "would",
]);

/** Lower-case word stems of a title, without filler. */
export function titleWords(title: string): string[] {
  const out = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw)) continue;
    // A crude stem is enough: plural and -ing/-ed endings.
    const stem = raw.replace(/(ing|ed|es|s)$/, "");
    out.add(stem.length >= 3 ? stem : raw);
  }
  return [...out].sort();
}

/** How much two sets of words overlap, 0 to 1. */
export function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(a);
  const shared = b.filter((w) => set.has(w)).length;
  return shared / (a.length + b.length - shared);
}

/** Two titles this alike are one opportunity. */
export const SAME_IDEA = 0.6;

/** The key an opportunity gets when none was given: its words, in order, so a reworded title is still the same key. */
export function opportunityKey(title: string): string {
  return `opp:${titleWords(title).join("-").slice(0, 120)}`;
}
