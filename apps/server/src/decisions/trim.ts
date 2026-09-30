import type { DecideState, LayaQuestion } from "@majhi/shared";

/**
 * Laya's English checkpoint reads 512 tokens per question: `[CLS] <type> question: <instructions>
 * [SEP] [MASK] option ... [SEP] <state> [SEP]`. The question and its options get at most 192 of them,
 * each option at most 48, and the state what is left. majhi fits the state itself, with a token
 * estimate that errs high, so Laya never cuts it silently and `trimmed` tells the truth.
 */
export const LAYA_WINDOW = 512;
const HEAD_MAX = 192;
const OPTION_MAX = 48;

/**
 * A token count that errs high for Laya's tokenizer (ModernBERT's BPE): a word counts one per 4
 * letters, a change of case starts a new word, each digit and each mark counts one, and any other
 * character one per UTF-8 byte. Checked against the real tokenizer on prose, JSON, code, model ids,
 * keys and accented text: up to 45 percent over, never under.
 */
export function estimateTokens(text: string): number {
  let n = 0;
  for (const m of text.matchAll(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]|[!-/:-@[-`{-~]|[^\s\x21-\x7e]/gu)) {
    const s = m[0];
    if (/^[A-Za-z]/.test(s)) n += Math.ceil(s.length / 4);
    else if (s.charCodeAt(0) < 0x80) n += 1;
    else n += Buffer.byteLength(s, "utf8");
  }
  return n;
}

/** The option texts Laya renders for a question, in order. */
function renderOptions(q: LayaQuestion): string[] {
  const c = q.criteria;
  if (q.type === "choice") {
    if (Array.isArray(c)) return c;
    return Object.entries(c ?? {}).map(([k, v]) => (v === "" ? k : `${k}: ${v}`));
  }
  if (q.type === "score") return (Array.isArray(c) ? c : []).map((v, i) => `level ${i}: ${v}`);
  const d = Array.isArray(c) ? {} : (c ?? {});
  return [
    `false: ${d.false || "no, the statement does not hold"}`,
    `true: ${d.true || "yes, the statement holds"}`,
  ];
}

/** Tokens a question takes before the state, and whether Laya cuts its text to fit. */
export function questionTokens(q: LayaQuestion): { tokens: number; cut: boolean } {
  const head = estimateTokens(`${q.type} question: ${q.instructions}`);
  const full = renderOptions(q).map((o) => 1 + estimateTokens(` ${o}`));
  let options = full.map((t) => Math.min(t, OPTION_MAX + 1));
  let cut = options.some((t, i) => t < (full[i] ?? 0));
  if (HEAD_MAX - sum(options) < 16) {
    const per = Math.max(4, Math.floor((HEAD_MAX - 16) / Math.max(1, options.length)));
    options = options.map((t) => Math.min(t, per));
    cut = true;
  }
  const room = Math.max(8, HEAD_MAX - sum(options));
  if (head > room) cut = true;
  return { tokens: 3 + sum(options) + Math.min(head, room), cut };
}

function sum(list: readonly number[]): number {
  return list.reduce((a, b) => a + b, 0);
}

/** The state as Laya reads it: text as is, fields as JSON the way Python's `json.dumps` writes it. */
export function renderState(state: DecideState): string {
  if (typeof state === "string") return state;
  return `{${Object.entries(state)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(", ")}}`;
}

/** Tokens left for the state: what the longest question leaves of the window. */
export function stateBudget(questions: readonly LayaQuestion[], window = LAYA_WINDOW): number {
  const longest = Math.max(0, ...questions.map((q) => questionTokens(q).tokens));
  return Math.max(0, window - longest - 1);
}

function cut(text: string, chars: number): string {
  return chars >= text.length ? text : `${text.slice(0, chars).trimEnd()}…`;
}

/** The longest start of `text` (in characters) for which `fits` holds, by binary search. */
function longestFit(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  let lo = 0;
  let hi = text.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(text, mid))) lo = mid;
    else hi = mid - 1;
  }
  return cut(text, lo);
}

/**
 * Fits the state into `budget` tokens. Text keeps its start, which holds the brief. Fields are cut
 * longest first, each keeping its start, so a short field like the role is never lost to a long one.
 */
export function fitState(state: DecideState, budget: number): { state: DecideState; trimmed: boolean } {
  const fits = (s: DecideState) => estimateTokens(renderState(s)) <= budget;
  if (fits(state)) return { state, trimmed: false };
  if (typeof state === "string") return { state: longestFit(state, fits), trimmed: true };
  const fields = { ...state };
  for (let i = 0; i < Object.keys(fields).length && !fits(fields); i++) {
    const [key, value] = Object.entries(fields).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    if (key === undefined || value === undefined || value === "") break;
    fields[key] = longestFit(value, (v) => fits({ ...fields, [key]: v }));
  }
  return { state: fields, trimmed: true };
}

/** Cuts text to about `tokens` tokens, keeping the start. For the stand-in agent, which has a real window. */
export function trimText(text: string, tokens: number): { text: string; trimmed: boolean } {
  const max = tokens * 4;
  if (text.length <= max) return { text, trimmed: false };
  return { text: `${text.slice(0, max - 1).trimEnd()}…`, trimmed: true };
}
