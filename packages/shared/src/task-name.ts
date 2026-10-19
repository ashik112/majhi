import { z } from "zod";
import { BRANCH_TYPES } from "./accounts.ts";

/**
 * A task's short name and the three lines its agent keeps current (docs/briefs/workflow-reset.md,
 * Step 1). The name is what the owner sees ("Acme · Login redirect"); the id stays internal.
 */

/** The longest a task name is, in characters. */
export const TASK_NAME_MAX = 32;
/** The most words a task name has. */
export const TASK_NAME_WORDS = 4;
/** The longest Now, Next or Done when line. */
export const TASK_LINE_MAX = 120;

function wordsOf(text: string): string[] {
  return text.split(" ").filter((w) => w !== "");
}

/** At most 4 words and 32 characters; creators are told to give 2 to 4. */
export const TaskNameSchema = z
  .string()
  .trim()
  .min(1, "A name has at least one word")
  .max(TASK_NAME_MAX, `A name is at most ${TASK_NAME_MAX} characters`)
  .refine((s) => wordsOf(s).length <= TASK_NAME_WORDS, `A name is at most ${TASK_NAME_WORDS} words`);

/** One of the lines a task shows: Now, Next, Done when. */
export const TaskLineSchema = z.string().trim().min(1).max(TASK_LINE_MAX);

/**
 * Words that carry no meaning in a name or at the end of a branch slug. `DANGLING_WORDS` also cannot
 * end a slug ("when", "the"); a name drops the wider `STOP_WORDS` everywhere.
 */
export const DANGLING_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "on",
  "in",
  "at",
  "by",
  "for",
  "and",
  "or",
  "with",
  "when",
  "is",
  "are",
  "if",
  "as",
]);

export const STOP_WORDS: ReadonlySet<string> = new Set([
  ...DANGLING_WORDS,
  "please",
  "can",
  "could",
  "you",
  "we",
  "i",
  "it",
  "this",
  "that",
  "my",
  "our",
  "be",
  "so",
  "do",
]);

const COMMIT_TYPE_WORDS: ReadonlySet<string> = new Set([...BRANCH_TYPES, "feature", "bugfix", "hotfix"]);

const isLetterOrDigit = (c: string): boolean => c.toLowerCase() !== c.toUpperCase() || (c >= "0" && c <= "9");

/** A word with the punctuation around it cut off ("(login)," is "login"). Inner characters stay. */
function trimWord(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && !isLetterOrDigit(word.charAt(start))) start++;
  while (end > start && !isLetterOrDigit(word.charAt(end - 1))) end--;
  return word.slice(start, end);
}

/** True for `fix:`, `feat(api):`, `chore!:`: the type prefix of a conventional title. */
function isTypePrefix(token: string): boolean {
  if (!token.endsWith(":")) return false;
  const head = token.slice(0, -1).split("(")[0]?.split("!").join("") ?? "";
  return COMMIT_TYPE_WORDS.has(head.toLowerCase());
}

/**
 * The first four meaningful words of a title, as a name: links, @mentions, a leading `type(scope):`
 * and stop words are left out, the first letter is a capital, and it is cut between words to fit
 * 32 characters. Empty only when the title has no letter or digit.
 */
export function nameFromTitle(title: string): string {
  const tokens = wordsOf(title.split("\n").join(" "));
  if (tokens[0] !== undefined && isTypePrefix(tokens[0])) tokens.shift();
  const words: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://") || token.startsWith("@")) continue;
    const word = trimWord(token);
    if (word === "" || STOP_WORDS.has(word.toLowerCase())) continue;
    words.push(word);
    if (words.length === TASK_NAME_WORDS) break;
  }
  let name = "";
  for (const word of words) {
    const next = name === "" ? word : `${name} ${word}`;
    if (next.length > TASK_NAME_MAX) break;
    name = next;
  }
  if (name === "" && words[0] !== undefined) name = words[0].slice(0, TASK_NAME_MAX);
  return name === "" ? "" : `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** The longest a slug made from a name is. */
export const NAME_SLUG_MAX = 40;

/**
 * The slug of a name, for a branch (`feat/login-redirect`) and a folder: lowercase ASCII letters and
 * digits joined by dashes, cut between words at 40 characters, never ending on a word that cannot end
 * a name ("when", "the"). The one function both the branch and the folder derive from; empty only when
 * the name has no letter or digit.
 */
export function slugOfName(name: string): string {
  const words: string[] = [];
  let word = "";
  for (const ch of name.normalize("NFD").toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) word += ch;
    else {
      // Accents split off by NFD are marks, not separators.
      const mark = ch >= "̀" && ch <= "ͯ";
      if (!mark && word !== "") words.push(word);
      if (!mark) word = "";
    }
  }
  if (word !== "") words.push(word);
  let slug = "";
  for (const w of words) {
    const next = slug === "" ? w : `${slug}-${w}`;
    if (next.length > NAME_SLUG_MAX) break;
    slug = next;
  }
  if (slug === "") return (words[0] ?? "").slice(0, NAME_SLUG_MAX);
  const kept = slug.split("-");
  while (kept.length > 1 && DANGLING_WORDS.has(kept[kept.length - 1] ?? "")) kept.pop();
  return kept.join("-");
}

/** What a task is called: its name, or the first words of its title for a task made before names. */
export function taskNameOf(task: { name?: string | undefined; title: string }): string {
  if (task.name !== undefined && task.name !== "") return task.name;
  const derived = nameFromTitle(task.title);
  return derived === "" ? task.title.slice(0, TASK_NAME_MAX).trim() : derived;
}

/** The part of a task that tells the reader where: its first project, else its workspace's name. */
export interface LabelTask {
  id: string;
  title: string;
  name?: string | undefined;
  repos: readonly { project: string }[];
  org?: string | undefined;
}

/**
 * `project · Name`: how every screen shows a task. The first repo's project; with none, the workspace
 * name the caller knows (the org id when it does not). The id never shows: it stays in the address
 * and in a tooltip.
 */
export function taskLabel(task: LabelTask, workspaceName?: string): string {
  const where = task.repos[0]?.project ?? workspaceName ?? task.org ?? "Private";
  return `${where} · ${taskNameOf(task)}`;
}
