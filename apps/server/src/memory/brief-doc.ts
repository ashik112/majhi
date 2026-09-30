import { BRIEF_BULLETS, BRIEF_SECTIONS, BRIEF_WORDS, type BriefSection } from "@majhi/shared";

/** A brief as its sections, in the fixed order. A missing section is empty. */
export type BriefSections = Record<BriefSection, string>;

const EMPTY: BriefSections = Object.fromEntries(BRIEF_SECTIONS.map((s) => [s, ""])) as BriefSections;

/** The section a heading names, matched without case. */
export function sectionOf(name: string): BriefSection | undefined {
  const key = name.trim().toLowerCase();
  return BRIEF_SECTIONS.find((s) => s.toLowerCase() === key);
}

/** Reads `## <section>` blocks. Text under an unknown heading, or before the first, is left out. */
export function parseBrief(body: string): BriefSections {
  const out: BriefSections = { ...EMPTY };
  let current: BriefSection | undefined;
  const lines = new Map<BriefSection, string[]>();
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] !== undefined) {
      current = sectionOf(heading[1]);
      continue;
    }
    if (current !== undefined) lines.set(current, [...(lines.get(current) ?? []), line]);
  }
  for (const s of BRIEF_SECTIONS) out[s] = (lines.get(s) ?? []).join("\n").trim();
  return out;
}

export function renderBrief(sections: BriefSections): string {
  return `${BRIEF_SECTIONS.map((s) => `## ${s}\n\n${sections[s].trim() || "Nothing yet."}`).join("\n\n")}\n`;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w !== "").length;
}

/** The first `max` words of a text, with an ellipsis when it was cut. */
export function firstWords(text: string, max: number): string {
  const words = text.split(/(\s+)/);
  let n = 0;
  let out = "";
  for (const part of words) {
    if (part.trim() !== "") {
      if (n === max) return `${out.trimEnd()} ...`;
      n += 1;
    }
    out += part;
  }
  return out;
}

/** A bullet is one line of at most about this many words. */
export const BULLET_WORDS = 32;

const NOTHING = /^nothing yet\.?$/i;

/**
 * A section's text as short bullets: list items stay items, prose splits into its sentences, and
 * headings are dropped. At most `BRIEF_BULLETS`, each one line of at most `BULLET_WORDS` words.
 */
export function bulletsOf(text: string): string[] {
  const items: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || NOTHING.test(line)) continue;
    const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item?.[1] !== undefined) items.push(item[1]);
    else items.push(...line.split(/(?<=[.!?])\s+(?=[A-Z0-9`"(])/));
  }
  return items
    .map((i) => i.replace(/\s+/g, " ").trim())
    .filter((i) => i !== "")
    .slice(0, BRIEF_BULLETS)
    .map((i) => capWords(i, BULLET_WORDS));
}

/** `firstWords`, but a text already cut to `max` stays as it is, so tidying twice changes nothing. */
function capWords(text: string, max: number): string {
  const plain = text.replace(/\s+\.\.\.$/, "");
  return wordCount(plain) <= max ? text : firstWords(plain, max);
}

/** A section in the brief's one shape: `- ` bullets, one per line. Empty when it says nothing. */
export function tidySection(text: string): string {
  return bulletsOf(text)
    .map((b) => `- ${b}`)
    .join("\n");
}

/** The words of a section's bullets, without the `- ` markers. */
export function bulletWords(text: string): number {
  return bulletsOf(text).reduce((n, b) => n + wordCount(b.replace(/\s+\.\.\.$/, "")), 0);
}

/**
 * The brief with the patch applied: each section the patch names is replaced, the others stay as
 * they were. Unknown section names are ignored. Every section comes out as short bullets and the
 * whole under about `BRIEF_WORDS`: the longest sections lose bullets first. Undefined when the
 * patch changes nothing.
 */
export function applyPatch(
  body: string | undefined,
  patch: Readonly<Record<string, string>>,
  maxWords = BRIEF_WORDS,
): string | undefined {
  const sections = body === undefined ? { ...EMPTY } : parseBrief(body);
  let changed = false;
  for (const [name, text] of Object.entries(patch)) {
    const section = sectionOf(name);
    if (section === undefined) continue;
    const next = tidySection(text);
    if (next === tidySection(sections[section])) continue;
    sections[section] = next;
    changed = true;
  }
  if (!changed) return undefined;
  const tidy = { ...EMPTY };
  for (const s of BRIEF_SECTIONS) tidy[s] = tidySection(sections[s]);
  return renderBrief(capSections(tidy, maxWords));
}

/**
 * Drops the last bullet of the longest section until the brief's bullets fit in `maxWords`. Each
 * section keeps its first bullet; when those alone are too long, the longest one is cut by words.
 */
export function capSections(sections: BriefSections, maxWords: number): BriefSections {
  const out = { ...sections };
  const total = () => BRIEF_SECTIONS.reduce((n, s) => n + bulletWords(out[s]), 0);
  const longest = (among: readonly BriefSection[]) =>
    among.reduce((a, b) => (bulletWords(out[b]) > bulletWords(out[a]) ? b : a));
  for (let i = 0; i < 200 && total() > maxWords; i++) {
    const trimmable = BRIEF_SECTIONS.filter((s) => bulletsOf(out[s]).length > 1);
    if (trimmable.length > 0) {
      const s = longest(trimmable);
      out[s] = tidySection(
        bulletsOf(out[s])
          .slice(0, -1)
          .map((b) => `- ${b}`)
          .join("\n"),
      );
      continue;
    }
    const s = longest(BRIEF_SECTIONS);
    const words = bulletWords(out[s]);
    if (words <= 8) break;
    out[s] = `- ${capWords(bulletsOf(out[s])[0] ?? "", Math.max(8, words - (total() - maxWords)))}`;
  }
  return out;
}

/** The brief cut to about `maxChars`, for TASK.md: each section keeps its start. */
export function compactBrief(body: string, maxChars: number): string {
  const sections = parseBrief(body);
  const present = BRIEF_SECTIONS.filter((s) => sections[s] !== "" && sections[s] !== "Nothing yet.");
  if (present.length === 0) return "";
  const share = Math.max(80, Math.floor(maxChars / present.length) - 20);
  const text = present
    .map((s) => {
      const t = sections[s].replace(/\n{2,}/g, "\n");
      return `**${s}.** ${t.length > share ? `${t.slice(0, share).trimEnd()} ...` : t}`;
    })
    .join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars - 4).trimEnd()} ...` : text;
}
