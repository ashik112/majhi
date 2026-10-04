/**
 * Wording of what the captain stored about a decision, made plain for the owner. Pure.
 *
 * Reasons stored before the authority table speak of levels ("Umbrella is set to Keeps things tidy, so the
 * captain asks before shipping"). The levels are gone; the rule is now "you decide when work is merged".
 * Those sentences are rewritten into that, so old text never shows a name that no screen has.
 */

/** A name of the old levels, or a sentence that says a workspace "is set to" one. */
const OLD_LEVEL = /\b(keeps things tidy|runs it|only when i ask|ask me with upkeep)\b|\b(?:is|are) set to\b/i;
const ABOUT_SHIPPING = /\b(ship|ships|shipping|shipped|merge|merges|merged|merging|asks? before)\b/i;

export function authorityLine(workspace: string | undefined): string {
  return `In ${workspace ?? "this workspace"} you decide when work is merged.`;
}

/** Splits into sentences, keeping each one's closing mark. */
function sentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()) ?? [];
}

/**
 * The text with each sentence about an old level rewritten as the authority sentence (once), or
 * dropped when it is not about shipping or merging.
 */
export function plainAuthorityText(text: string, workspace?: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!OLD_LEVEL.test(flat)) return flat;
  const line = authorityLine(workspace);
  const out: string[] = [];
  for (const sentence of sentences(flat)) {
    if (sentence === "") continue;
    if (!OLD_LEVEL.test(sentence)) {
      out.push(sentence);
      continue;
    }
    if (ABOUT_SHIPPING.test(sentence) && !out.includes(line)) out.push(line);
  }
  return out.join(" ");
}

/**
 * The captain's line on a ready-to-ship card ("Ready to ship to main: committed, merges cleanly into
 * main, no card waits. In Acme you decide when work is merged.") as what it checked and what it adds.
 */
export function splitReady(line: string, workspace?: string): { checks?: string; note?: string } {
  const plain = plainAuthorityText(line, workspace);
  const found = /^Ready to ship(?: to [^:]+)?:\s*(.+?)\.(?:\s+(.*))?$/s.exec(plain);
  if (found === null) return plain === "" ? {} : { note: plain };
  const [, checks, note] = found;
  return {
    ...(checks === undefined || checks === "" ? {} : { checks }),
    ...(note === undefined || note === "" ? {} : { note }),
  };
}
