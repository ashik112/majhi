import type { GitlabFile } from "../ci/read.ts";

/**
 * A GitLab pipeline's jobs read as typed data: a job with its `extends` merged in, its variables, and the lines of its
 * script split into words. Nothing here matches text with a pattern: names are looked up in tables, a script line is
 * cut at its separators and read word by word.
 */

const rec = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string | undefined =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;

/** The top-level keys of a pipeline file that are not jobs. */
const KEYWORDS = new Set([
  "stages",
  "variables",
  "default",
  "include",
  "workflow",
  "image",
  "services",
  "before_script",
  "after_script",
  "cache",
  "pages",
]);

export interface JobEntry {
  name: string;
  file: GitlabFile;
}

/** Every job of the pipeline's files, hidden templates included, the first one of a name winning. */
export function jobEntries(files: readonly GitlabFile[]): Map<string, JobEntry> {
  const out = new Map<string, JobEntry>();
  for (const file of files) {
    for (const [name, raw] of Object.entries(rec(file.located.data))) {
      if (KEYWORDS.has(name) || typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
      if (!out.has(name)) out.set(name, { name, file });
    }
  }
  return out;
}

function mergeDeep(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const was = out[key];
    out[key] =
      typeof value === "object" && value !== null && !Array.isArray(value) && typeof was === "object"
        ? mergeDeep(rec(was), rec(value))
        : value;
  }
  return out;
}

/** A job with the jobs it `extends` merged under it: hashes merge, anything else the job itself says wins. */
export function resolveJob(
  name: string,
  entries: ReadonlyMap<string, JobEntry>,
  seen: readonly string[] = [],
): Record<string, unknown> {
  const entry = entries.get(name);
  if (entry === undefined || seen.includes(name)) return {};
  const own = rec(rec(entry.file.located.data)[name]);
  const parents = Array.isArray(own.extends) ? own.extends : own.extends === undefined ? [] : [own.extends];
  let out: Record<string, unknown> = {};
  for (const parent of parents) {
    if (typeof parent === "string") out = mergeDeep(out, resolveJob(parent, entries, [...seen, name]));
  }
  return mergeDeep(out, own);
}

/** One variable of a job: its value, and what GitLab's typed form says about it (`description`, `options`). */
export interface JobVariable {
  value: string;
  description: string | undefined;
  options: string[];
}

export function jobVariables(job: Record<string, unknown>): Map<string, JobVariable> {
  const out = new Map<string, JobVariable>();
  for (const [name, raw] of Object.entries(rec(job.variables))) {
    const typed = rec(raw);
    const scalar = text(raw);
    const options = Array.isArray(typed.options)
      ? typed.options.map(text).filter((o): o is string => o !== undefined)
      : [];
    out.set(name, {
      value: scalar ?? text(typed.value) ?? "",
      description: text(typed.description),
      options,
    });
  }
  return out;
}

/** The lines of a job's `before_script` and `script`, in order. Anything that is not a plain line is left out. */
export function scriptLines(job: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["before_script", "script"]) {
    const value = job[key];
    for (const line of Array.isArray(value) ? value : [value]) {
      if (typeof line === "string") out.push(...line.split("\n"));
    }
  }
  return out.map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

const SEPARATORS = new Set([";", "&", "|", "(", ")"]);
const QUOTES = new Set(['"', "'"]);

function isNameChar(c: string): boolean {
  return (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_";
}

/** The commands of a script line, each cut into words: `a; b && c` is three commands. Quotes around a word are dropped. */
export function commandsOf(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  const endWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (const c of line) {
    if (SEPARATORS.has(c)) endCommand();
    else if (c === " " || c === "\t") endWord();
    else if (!QUOTES.has(c)) word += c;
  }
  endCommand();
  return commands;
}

/** The names of the variables a word refers to: `$TARGET` and `${TARGET}`. */
export function referencesOf(word: string): string[] {
  const names: string[] = [];
  for (let i = 0; i < word.length; i++) {
    if (word[i] !== "$") continue;
    let at = i + 1;
    if (word[at] === "{") at++;
    let name = "";
    while (at < word.length && isNameChar(word[at] ?? "")) name += word[at++];
    if (name !== "") names.push(name);
  }
  return names;
}

/** The text with each `$NAME` and `${NAME}` of `values` replaced by its value. Names not in `values` stay. */
export function expandVariables(input: string, values: ReadonlyMap<string, string>): string {
  let out = "";
  for (let i = 0; i < input.length; i++) {
    if (input[i] !== "$") {
      out += input[i];
      continue;
    }
    let at = i + 1;
    const braced = input[at] === "{";
    if (braced) at++;
    let name = "";
    while (at < input.length && isNameChar(input[at] ?? "")) name += input[at++];
    const value = values.get(name);
    if (name === "" || value === undefined || (braced && input[at] !== "}")) {
      out += input[i];
      continue;
    }
    out += value;
    i = braced ? at : at - 1;
  }
  return out;
}

/** The files a script reads its settings from: the word after `source` or `.`, with the variables of the job put in. */
export function sourcedPaths(lines: readonly string[], values: ReadonlyMap<string, string>): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const words of commandsOf(line)) {
      const [first, second] = words;
      if ((first === "source" || first === ".") && second !== undefined) {
        const path = expandVariables(second, values);
        if (!path.includes("$") && !out.includes(path)) out.push(path);
      }
    }
  }
  return out;
}

/** The script files a job runs: words that end in `.sh`, as paths from the repo's root. */
export function scriptFiles(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    for (const words of commandsOf(line)) {
      for (const word of words) {
        if (!word.endsWith(".sh") || word.includes("$")) continue;
        const path = word.startsWith("./") ? word.slice(2) : word;
        if (!path.startsWith("/") && !path.includes("..") && !out.includes(path)) out.push(path);
      }
    }
  }
  return out;
}

/**
 * The variables a script compares: a command whose words refer to exactly two variables the job declares, one of them
 * a confirmation (`[ "$CONFIRM_TARGET" = "$TARGET" ]`). Pairs are `[confirmation, the variable it must equal]`.
 */
export function confirmationsRead(
  lines: readonly string[],
  declared: ReadonlySet<string>,
  isConfirm: (name: string) => boolean,
): [string, string][] {
  const out: [string, string][] = [];
  for (const line of lines) {
    for (const words of commandsOf(line)) {
      const names = [...new Set(words.flatMap(referencesOf))].filter((n) => declared.has(n));
      const confirm = names.find(isConfirm);
      const other = names.find((n) => !isConfirm(n));
      if (confirm !== undefined && other !== undefined && names.length === 2) out.push([confirm, other]);
    }
  }
  return out;
}

/** The `KEY=value` lines of a plain settings file. A value that holds `$`, a backtick or `(` is not plain and is left out. */
export function plainSettings(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of file.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (value.length >= 2 && quote !== undefined && QUOTES.has(quote) && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    if (![...key].every(isNameChar)) continue;
    if (value.includes("$") || value.includes("`") || value.includes("(")) continue;
    out.set(key, value);
  }
  return out;
}
