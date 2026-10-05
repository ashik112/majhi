import { join } from "node:path";

const WORD = /[a-z0-9]+/g;
const STOP = new Set(["the", "a", "an", "to", "for", "of", "and", "or", "in", "on", "with", "my", "is"]);
const LINE_MAX = 160;

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

export interface FoundSkill {
  name: string;
  description: string;
}

/**
 * The skills that best match a few words, best first. A word in the name counts more than one in
 * the description; a word that starts another counts too. Skills with no match are left out.
 */
export function rankSkills(skills: readonly FoundSkill[], query: string, limit = 5): FoundSkill[] {
  const wanted = words(query);
  if (wanted.length === 0) return [];
  const scored = skills.flatMap((s) => {
    const name = new Set(words(s.name.replace(/[-_]/g, " ")));
    const description = words(s.description);
    let score = 0;
    for (const w of wanted) {
      if (name.has(w)) score += 3;
      else if ([...name].some((n) => n.startsWith(w) || w.startsWith(n))) score += 1.5;
      if (description.includes(w)) score += 1;
      else if (description.some((d) => d.startsWith(w))) score += 0.5;
    }
    return score > 0 ? [{ s, score }] : [];
  });
  return scored
    .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name))
    .slice(0, limit)
    .map((x) => x.s);
}

/** One line per match: name, a short description and where its SKILL.md is in this run. */
export function foundLines(dir: string, found: readonly FoundSkill[]): string {
  if (found.length === 0) return "No skill matches. Try other words, or go on without one.";
  return found
    .map((s) => {
      const d = s.description.replace(/\s+/g, " ").trim();
      const short = d.length > LINE_MAX ? `${d.slice(0, LINE_MAX - 1)}…` : d;
      return `- ${s.name}: ${short} (${join(dir, s.name, "SKILL.md")})`;
    })
    .join("\n");
}
