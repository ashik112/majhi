import { BRIEF_SECTIONS, BRIEF_WORDS, type BriefSection } from "@majhi/shared";

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

/**
 * The brief with the patch applied: each section the patch names is replaced, the others stay as
 * they were. Unknown section names are ignored. The result is kept under about `BRIEF_WORDS`: the
 * longest sections are cut first. Undefined when the patch changes nothing.
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
    const next = text.trim();
    if (next === sections[section]) continue;
    sections[section] = next;
    changed = true;
  }
  if (!changed) return undefined;
  return renderBrief(capSections(sections, maxWords));
}

/** Cuts the longest section by a tenth at a time until the whole brief fits in `maxWords`. */
export function capSections(sections: BriefSections, maxWords: number): BriefSections {
  const out = { ...sections };
  const total = () => BRIEF_SECTIONS.reduce((n, s) => n + wordCount(out[s]), 0);
  for (let i = 0; i < 200 && total() > maxWords; i++) {
    const longest = BRIEF_SECTIONS.reduce((a, b) => (wordCount(out[b]) > wordCount(out[a]) ? b : a));
    const words = wordCount(out[longest]);
    out[longest] = firstWords(out[longest], Math.max(20, Math.floor(words * 0.9)));
    if (words <= 20) break;
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
