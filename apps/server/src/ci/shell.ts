/**
 * A shell line read into commands, by a small scanner and no pattern matching: quotes, escapes and the
 * operators `&&`, `||`, `;`, `|` and `&` are understood, `NAME=value` words in front of a command are its
 * environment. Majhi decides what a check does from these parts, never from the text of the whole line.
 * A line it cannot read with certainty (an unclosed quote, a subshell, a heredoc) is `unreadable`, and
 * is then run as the author wrote it.
 */

export type Operator = "&&" | "||" | ";" | "|" | "&";

export interface Segment {
  /** `NAME=value` words that came before the command. */
  env: Record<string, string>;
  /** The command and its arguments, quotes removed. */
  argv: string[];
  /** What joins this command to the next one. Absent on the last. */
  joins?: Operator;
}

export type ShellLine = { ok: true; segments: Segment[] } | { ok: false; why: string };

const isNameChar = (c: string, first: boolean): boolean =>
  c === "_" || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (!first && c >= "0" && c <= "9");

/** True for `NAME=` at the start of a word, with the position of the equals sign. */
function assignmentAt(word: string): number | undefined {
  for (let i = 0; i < word.length; i++) {
    const c = word[i] ?? "";
    if (c === "=") return i > 0 ? i : undefined;
    if (!isNameChar(c, i === 0)) return undefined;
  }
  return undefined;
}

interface Word {
  text: string;
  /** Written with a quote or an escape: never an assignment or an operator. */
  quoted: boolean;
  /** Has an unquoted `$` or a backtick: its value is not known before it runs. */
  dynamic: boolean;
}

/** Splits a line into words and operators. */
function scan(line: string): { words: (Word | Operator)[] } | { why: string } {
  const out: (Word | Operator)[] = [];
  let cur: Word | undefined;
  const push = () => {
    if (cur !== undefined) out.push(cur);
    cur = undefined;
  };
  const add = (c: string, quoted: boolean, dynamic = false) => {
    cur ??= { text: "", quoted: false, dynamic: false };
    cur.text += c;
    if (quoted) cur.quoted = true;
    if (dynamic) cur.dynamic = true;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    const next = line[i + 1] ?? "";
    if (c === "\\") {
      if (next === "\n") {
        i++;
        continue;
      }
      if (next === "") return { why: "the line ends with a backslash" };
      add(next, true);
      i++;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { why: "a quote is not closed" };
      cur ??= { text: "", quoted: true, dynamic: false };
      cur.quoted = true;
      cur.text += line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      cur ??= { text: "", quoted: true, dynamic: false };
      cur.quoted = true;
      let j = i + 1;
      for (; j < line.length && line[j] !== '"'; j++) {
        const d = line[j] ?? "";
        if (d === "\\" && j + 1 < line.length) {
          const e = line[j + 1] ?? "";
          if (e === '"' || e === "\\" || e === "$" || e === "`") {
            cur.text += e;
            j++;
            continue;
          }
        }
        if (d === "$" || d === "`") cur.dynamic = true;
        cur.text += d;
      }
      if (j >= line.length) return { why: "a quote is not closed" };
      i = j;
    } else if (c === " " || c === "\t") {
      push();
    } else if (c === "\n" || c === ";") {
      push();
      out.push(";");
    } else if (c === "&" && next === "&") {
      push();
      out.push("&&");
      i++;
    } else if (c === "|" && next === "|") {
      push();
      out.push("||");
      i++;
    } else if (c === "|") {
      push();
      out.push("|");
    } else if (c === "&") {
      push();
      out.push("&");
    } else if (c === "#" && cur === undefined) {
      const end = line.indexOf("\n", i);
      if (end < 0) break;
      i = end - 1;
    } else if (c === "(" || c === ")" || c === "{" || c === "}") {
      return { why: "it groups commands" };
    } else if (c === "<" || c === ">") {
      return { why: "it redirects input or output" };
    } else if (c === "`") {
      add(c, false, true);
    } else {
      add(c, false, c === "$");
    }
  }
  push();
  return { words: out };
}

/** Reads a line into its commands. */
export function parseShell(line: string): ShellLine {
  const scanned = scan(line);
  if ("why" in scanned) return { ok: false, why: scanned.why };
  const segments: Segment[] = [];
  let seg: Segment = { env: {}, argv: [] };
  for (const w of scanned.words) {
    if (typeof w === "string") {
      if (seg.argv.length === 0 && Object.keys(seg.env).length === 0) {
        if (w === ";") continue;
        return { ok: false, why: "an operator has no command before it" };
      }
      seg.joins = w;
      segments.push(seg);
      seg = { env: {}, argv: [] };
      continue;
    }
    if (w.dynamic) return { ok: false, why: "it uses a value that is only known when it runs" };
    const eq = seg.argv.length === 0 && !w.quoted ? assignmentAt(w.text) : undefined;
    if (eq !== undefined) seg.env[w.text.slice(0, eq)] = w.text.slice(eq + 1);
    else seg.argv.push(w.text);
  }
  if (seg.argv.length > 0 || Object.keys(seg.env).length > 0) segments.push(seg);
  const last = segments.at(-1);
  if (last?.joins === "&&" || last?.joins === "||" || last?.joins === "|")
    return { ok: false, why: "it ends with an operator" };
  return { ok: true, segments };
}

const SAFE = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./:=@%+,");

/** A word as a shell reads it back unchanged. */
export function quoteWord(word: string): string {
  if (word !== "" && [...word].every((c) => SAFE.has(c))) return word;
  return `'${word.split("'").join(`'\\''`)}'`;
}

/** Commands back into one line. */
export function renderShell(segments: readonly Segment[]): string {
  return segments
    .map((s) => {
      const env = Object.entries(s.env).map(([k, v]) => `${k}=${quoteWord(v)}`);
      return [...env, ...s.argv.map(quoteWord)].join(" ") + (s.joins === undefined ? "" : ` ${s.joins}`);
    })
    .join(" ");
}

/** The program a command runs: its name without the folder in front of it. */
export function programOf(argv: readonly string[]): string {
  const first = argv[0] ?? "";
  const slash = first.lastIndexOf("/");
  return slash < 0 ? first : first.slice(slash + 1);
}
