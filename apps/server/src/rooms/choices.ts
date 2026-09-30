/**
 * The choices an agent offered the owner in plain text, read without a model (5.3): a short
 * numbered or bulleted list that a question introduces, or "A or B" / "X, Y or Z" in a question.
 * Conservative: when anything looks off, no choices, and the room offers only Reply.
 */

const MAX_CHOICES = 6;
/** A list item longer than this is a sentence, not a choice. */
const MAX_ITEM = 60;
const MAX_ITEM_WORDS = 8;
/** An option inside a question is shorter still. */
const MAX_OPTION = 40;
const MAX_OPTION_WORDS = 6;

const LIST_ITEM = /^\s{0,3}(?:[-*•+]|\d{1,2}[.)]|[A-Za-z][.)])\s+(\S.*)$/;
const CUE =
  /\b(options?|choose|choice|pick|which|prefer|would you like|want me to|should i|shall i|should we|next|decide|either|your call)\b/i;
const LEAD =
  /^(?:.*?[\s,;:])?(?:should i|shall i|should we|shall we|do you want me to|would you like me to|want me to|do you want to|would you like to|do you want|would you like|would you prefer|do you prefer|prefer to|prefer)\s+(.+)$/i;

export function readChoices(text: string): string[] {
  const clean = text
    .replace(/```[\s\S]*?```/g, "\n")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n");
  return listChoices(clean) ?? questionChoices(clean) ?? [];
}

/** The last list in the message, when a question or a choice cue introduces it and it ends the message. */
function listChoices(text: string): string[] | undefined {
  const lines = text.split("\n");
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIST_ITEM.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const items: string[] = [];
  let start = end;
  for (let i = end; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const m = LIST_ITEM.exec(line);
    if (m === null) break;
    items.unshift(m[1] ?? "");
    start = i;
  }
  const trailing = lines.slice(end + 1).filter((l) => l.trim() !== "");
  if (trailing.length > 2 || trailing.some((l) => l.length > 120)) return undefined;
  const leadIn = lines
    .slice(0, start)
    .reverse()
    .find((l) => l.trim() !== "")
    ?.trim();
  const after = trailing.join(" ");
  const cued =
    (leadIn !== undefined && (leadIn.endsWith("?") || (leadIn.endsWith(":") && CUE.test(leadIn)))) ||
    (after.includes("?") && CUE.test(after));
  if (!cued || items.length < 2 || items.length > MAX_CHOICES) return undefined;
  const labels = items.map(itemLabel);
  if (labels.some((l) => l === undefined)) return undefined;
  return distinct(labels as string[]);
}

/** A list item's label: its bold part, or the part before a colon or dash, when short. */
function itemLabel(item: string): string | undefined {
  const bold = /^\*\*(.+?)\*\*|^__(.+?)__/.exec(item.trim());
  let label = bold !== null ? (bold[1] ?? bold[2] ?? "") : item;
  if (bold === null) {
    const cut = /^(.+?)(?:\s+[-–—]\s+|:\s+)(.+)$/.exec(label);
    if (cut !== null && (cut[1] ?? "").length <= MAX_OPTION) {
      // "Option A: merge now" names the option by what it does.
      label = /^(option|choice)\s*\w{0,2}$/i.test((cut[1] ?? "").trim()) ? (cut[2] ?? "") : (cut[1] ?? "");
    }
  }
  const plain = tidy(label);
  if (plain === "" || plain.length > MAX_ITEM || words(plain) > MAX_ITEM_WORDS || plain.includes("?"))
    return undefined;
  return plain;
}

/** "Should I merge now or wait?", "Do you want A, B or C?": from the last question that has them. */
function questionChoices(text: string): string[] | undefined {
  const questions = text.match(/[^.!?\n]*\?/g) ?? [];
  for (const q of questions.reverse()) {
    const found = orOptions(q);
    if (found !== undefined) return found;
  }
  return undefined;
}

function orOptions(question: string): string[] | undefined {
  const q = question
    .replace(/\?$/, "")
    .replace(/(^|\s)@[\w-]+,?/g, " ")
    .replace(/[`*_]/g, "")
    .trim();
  const lead = LEAD.exec(q);
  if (lead === null) return undefined;
  const rest = (lead[1] ?? "").trim();
  const halves = rest.split(/\s+or\s+/i);
  if (halves.length !== 2) return undefined;
  const [left = "", right = ""] = halves;
  const options = [...left.split(/\s*,\s*/), right.replace(/\s+instead$/i, "")]
    .map(tidy)
    .filter((o) => o !== "");
  if (options.length < 2 || options.length > MAX_CHOICES) return undefined;
  for (const o of options) {
    if (o.length > MAX_OPTION || words(o) > MAX_OPTION_WORDS) return undefined;
    if (/^(not|something else|anything else|both|neither)$/i.test(o)) return undefined;
  }
  return distinct(options);
}

function tidy(text: string): string {
  const t = text
    .replace(/\*\*|__|`/g, "")
    .trim()
    .replace(/[.;,:!]+$/, "")
    .trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function distinct(labels: readonly string[]): string[] | undefined {
  const seen = new Set(labels.map((l) => l.toLowerCase()));
  return seen.size === labels.length ? [...labels] : undefined;
}
