import type { ParseContext, ParsedTask } from "./tasks.ts";

/** Longest title kept. */
export const TITLE_MAX = 120;

/** Words that follow `from` or `off` in plain speech, never a branch. */
const NOT_A_BRANCH = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "my",
  "our",
  "your",
  "their",
  "there",
  "here",
  "now",
  "then",
  "scratch",
  "which",
  "what",
  "where",
  "one",
  "each",
  "all",
  "any",
  "some",
  "other",
]);

const LINK = /https?:\/\/[^\s<>"'`]+/gi;
const LINK_TRAILING = /[.,;:!?)\]}>]+$/;
const BASE_PHRASE = /(?<![A-Za-z0-9_-])(?:from|off|base)(?:\s*:\s*|\s+)([A-Za-z0-9._/-]+)/gi;
const BRANCH_PHRASE = /(?<![A-Za-z0-9_-])(?:on|branch)(?:\s*:\s*|\s+)([A-Za-z0-9._/-]+)/gi;
const MENTION = /(?<![A-Za-z0-9_@/.-])@([A-Za-z0-9][A-Za-z0-9-]*)(?![A-Za-z0-9_/@-]|\.[A-Za-z0-9])/g;
const BRANCH_TRAILING = /[.,;:]+$/;

/** An investigation or an incident: no repo to change, something to find out (SPEC 5.15). */
const OPS_WORDS =
  /(?<![A-Za-z0-9_-])(?:investigat(?:e|es|ing|ion)|incidents?|outages?|post-?mortems?|root cause)(?![A-Za-z0-9_-])/i;
const OPS_WHY =
  /(?<![A-Za-z0-9_-])why\s+(?:is|are|was|were|did|does|do)\b[^.\n]*\b(?:down|failing|failed|broken|slow|erroring|unreachable|crashing|crashed|timing out|returning 5\d\d)\b/i;
const OPS_DEBUG = /(?<![A-Za-z0-9_-])debug\b[^.\n]*\b(?:in|on)\s+(?:prod|production|staging)\b/i;
/** With a repo named, these say the code changes. */
const CHANGE_VERBS =
  /(?<![A-Za-z0-9_-])(?:fix(?:es|ed|ing)?|add(?:s|ed|ing)?|change|update|build|create|write|rename|remove|delete|migrate|patch|bump|upgrade)(?![A-Za-z0-9_-])/i;
/** Words that say the code itself changes, which keeps the task `code` whatever else it says. */
const CODE_WORDS =
  /(?<![A-Za-z0-9_-])(?:implement(?:s|ed|ing)?|refactor(?:s|ed|ing)?|pull request|merge request|commit(?:s)?|PR)(?![A-Za-z0-9_-])/;

/**
 * Reads the task box text (SPEC 3.1): repos by project id or alias, base
 * branch (`from develop`, `base: main`, `off release/2.1`), working branch
 * (`on feature/x`, `branch fix/y`; must contain a slash), `@agent` mentions,
 * links, and warnings (unknown agents, repos from more than one org). A repo
 * means kind `code`. No repo means kind `ops` for an investigation or an incident
 * ("why is the api down in prod", "debug ... in prod"), else `chat`, with no warning. Pure and fast: it runs on every
 * keystroke.
 */
export function parseTaskText(text: string, ctx: ParseContext): ParsedTask {
  const links = findLinks(text);
  // Spans that must not count as repo names: links, branch phrases and mentions.
  const masked: [number, number][] = [];
  for (const link of links) masked.push([link.start, link.end]);

  const base = findPhrase(text, BASE_PHRASE, (token) => !NOT_A_BRANCH.has(token.toLowerCase()), masked);
  const branch = findPhrase(text, BRANCH_PHRASE, (token) => token.includes("/"), masked);

  const known = new Set(ctx.agents.map((a) => a.id));
  const mentions: string[] = [];
  const warnings: string[] = [];
  for (const m of text.matchAll(MENTION)) {
    const id = (m[1] ?? "").toLowerCase();
    masked.push([m.index, m.index + m[0].length]);
    if (known.has(id)) {
      if (!mentions.includes(id)) mentions.push(id);
    } else if (!warnings.includes(`Unknown agent @${id}`)) {
      warnings.push(`Unknown agent @${id}`);
    }
  }

  const repos = findRepos(text, ctx, masked);
  const orgs: string[] = [];
  for (const repo of repos) {
    const org = ctx.projects.find((p) => p.id === repo.project)?.org;
    if (org !== undefined && !orgs.includes(org)) orgs.push(org);
  }
  if (orgs.length > 1) warnings.push(`Repos from more than one org: ${orgs.join(", ")}`);

  const parsed: ParsedTask = {
    title: titleOf(text),
    repos,
    mentions,
    links: [...new Set(links.map((l) => l.url))],
    kind: kindOf(text, repos.length > 0, branch),
    warnings,
  };
  if (base !== undefined) parsed.base = base;
  if (branch !== undefined) parsed.branch = branch;
  if (orgs.length === 1 && orgs[0] !== undefined) parsed.org = orgs[0];
  return parsed;
}

/**
 * `ops` for an investigation or an incident, `code` when repos are named, else `chat`. Naming a
 * repo does not make an investigation code ("why is the api down in prod"), but a working branch, a code
 * word, or a change verb next to a named repo ("fix the timeout in api") does.
 */
function kindOf(text: string, hasRepos: boolean, branchNamed: string | undefined): ParsedTask["kind"] {
  const ops = OPS_WORDS.test(text) || OPS_WHY.test(text) || OPS_DEBUG.test(text);
  const changes = branchNamed !== undefined || CODE_WORDS.test(text) || (hasRepos && CHANGE_VERBS.test(text));
  if (ops && !changes) return "ops";
  return hasRepos ? "code" : "chat";
}

/** First non-empty line, whitespace trimmed, at most 120 characters. */
function titleOf(text: string): string {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const line = first.trim();
  if (line.length <= TITLE_MAX) return line;
  // Cut at a word, not in the middle of one, and show that it was cut.
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

interface FoundLink {
  url: string;
  start: number;
  end: number;
}

function findLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const m of text.matchAll(LINK)) {
    const url = m[0].replace(LINK_TRAILING, "");
    if (url.length > "https://".length) found.push({ url, start: m.index, end: m.index + m[0].length });
  }
  return found;
}

/** The token of the first phrase match that `accept`s it and does not sit inside a masked span. Masks the phrase. */
function findPhrase(
  text: string,
  pattern: RegExp,
  accept: (token: string) => boolean,
  masked: Array<[number, number]>,
): string | undefined {
  for (const m of text.matchAll(pattern)) {
    const token = (m[1] ?? "").replace(BRANCH_TRAILING, "");
    if (token === "" || !accept(token) || inside(masked, m.index)) continue;
    masked.push([m.index, m.index + m[0].length]);
    return token;
  }
  return undefined;
}

function inside(spans: readonly [number, number][], at: number): boolean {
  return spans.some(([start, end]) => at >= start && at < end);
}

const LEFT_BLOCK = /[A-Za-z0-9_@/.-]/;
const RIGHT_BLOCK = /[A-Za-z0-9_-]/;

/** Projects named by id or alias as whole words, in order of first mention. */
function findRepos(
  text: string,
  ctx: ParseContext,
  masked: readonly [number, number][],
): ParsedTask["repos"] {
  const lower = text.toLowerCase();
  const hits: { at: number; project: string; match: string }[] = [];
  for (const project of ctx.projects) {
    let earliest: { at: number; match: string } | undefined;
    for (const name of new Set([project.id, ...project.aliases])) {
      const at = findWord(lower, name.toLowerCase(), masked);
      if (at !== undefined && (earliest === undefined || at < earliest.at)) {
        earliest = { at, match: text.slice(at, at + name.length) };
      }
    }
    if (earliest !== undefined) hits.push({ ...earliest, project: project.id });
  }
  hits.sort((a, b) => a.at - b.at);
  return hits.map((h) => ({ project: h.project, match: h.match }));
}

/** Index of the first whole-word occurrence of `word` outside `masked`. */
function findWord(text: string, word: string, masked: readonly [number, number][]): number | undefined {
  if (word === "") return undefined;
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at === -1) return undefined;
    from = at + 1;
    const before = text[at - 1];
    const after = text[at + word.length];
    const nextDot = text[at + word.length + 1];
    if (before !== undefined && LEFT_BLOCK.test(before)) continue;
    if (after !== undefined && RIGHT_BLOCK.test(after)) continue;
    if (after === "." && nextDot !== undefined && /[A-Za-z0-9]/.test(nextDot)) continue;
    if (inside(masked, at)) continue;
    return at;
  }
}
