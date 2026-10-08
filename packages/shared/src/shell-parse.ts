/**
 * Splits a shell command line into its simple commands, the way a shell would read it, for the
 * connection gate. It reads quotes, escapes, `;` `&&` `||` `|` `&` and line breaks, ( ) and { }
 * groups, `$(...)` and backticks (their contents are command lines of their own), redirections and
 * here-documents, and comments. It runs nothing and expands nothing.
 */

export interface Redirect {
  /** `>`, `>>`, `<`, `<<`, `&>`, `2>` and the like. */
  op: string;
  /** The file, or `&1` for a descriptor. Empty for a here-document. */
  target: string;
}

export interface SimpleCommand {
  /** The words as the shell would pass them, quotes removed. A word with an expansion keeps its `$`. */
  words: string[];
  redirects: Redirect[];
}

export interface ParsedLine {
  commands: SimpleCommand[];
  /** The command lines inside `$(...)` and backticks, read on their own. */
  substitutions: string[];
}

export class ShellParseError extends Error {}

const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "\n", "(", ")"]);

type Token =
  | { kind: "word"; value: string }
  | { kind: "op"; value: string }
  | { kind: "redirect"; op: string };

/** Reads `line`. Throws ShellParseError for an unclosed quote or substitution. */
export function parseLine(line: string): ParsedLine {
  const substitutions: string[] = [];
  const tokens = lex(line, substitutions);
  const commands: SimpleCommand[] = [];
  let current: SimpleCommand = { words: [], redirects: [] };
  const flush = () => {
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
    current = { words: [], redirects: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "op") {
      flush();
      continue;
    }
    if (token.kind === "redirect") {
      const next = tokens[i + 1];
      if (token.op.endsWith("&") && next?.kind === "word" && /^\d+$|^-$/.test(next.value)) {
        current.redirects.push({ op: token.op.slice(0, -1), target: `&${next.value}` });
        i++;
      } else if (next?.kind === "word") {
        current.redirects.push({ op: token.op, target: next.value });
        i++;
      } else {
        current.redirects.push({ op: token.op, target: "" });
      }
      continue;
    }
    // A brace group's braces are words to the shell; here they only separate commands.
    if ((token.value === "{" || token.value === "}") && current.words.length === 0) {
      flush();
      continue;
    }
    current.words.push(token.value);
  }
  flush();
  return { commands, substitutions };
}

function lex(line: string, substitutions: string[]): Token[] {
  const tokens: Token[] = [];
  /** Here-document words waiting for the next line break. */
  const heredocs: { word: string; tabs: boolean }[] = [];
  let word = "";
  let inWord = false;
  const end = () => {
    if (inWord) tokens.push({ kind: "word", value: word });
    word = "";
    inWord = false;
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "\\") {
      // A backslash before a line break joins the lines.
      if (line[i + 1] === "\n") {
        i += 2;
        continue;
      }
      word += line[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) throw new ShellParseError("A single quote is not closed.");
      word += line.slice(i + 1, close);
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === '"') {
      i = readDoubleQuoted(line, i + 1, substitutions, (text) => {
        word += text;
      });
      inWord = true;
      continue;
    }
    if (ch === "`") {
      const close = findBacktick(line, i + 1);
      substitutions.push(line.slice(i + 1, close));
      word += "$(...)";
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === "$" && line[i + 1] === "(") {
      const close = findParen(line, i + 2);
      // `$((` is arithmetic, which runs nothing.
      if (line[i + 2] !== "(") substitutions.push(line.slice(i + 2, close));
      word += "$(...)";
      inWord = true;
      i = close + 1;
      continue;
    }
    if (ch === "#" && !inWord) {
      while (i < line.length && line[i] !== "\n") i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      end();
      i++;
      continue;
    }
    if (ch === "\n") {
      end();
      tokens.push({ kind: "op", value: "\n" });
      i++;
      i = skipHeredocs(line, i, heredocs);
      continue;
    }
    const redirect = /^(?:&>>|&>|>>|>\||<<<|<<-|<<|<>|>&|<&|>|<)/.exec(line.slice(i));
    if (redirect) {
      // A word of digits right before it is the descriptor: `2>`.
      const fd = inWord && /^\d+$/.test(word) ? word : "";
      if (fd !== "") {
        word = "";
        inWord = false;
      } else {
        end();
      }
      const op = `${fd}${redirect[0]}`;
      i += redirect[0].length;
      if (redirect[0] === "<<" || redirect[0] === "<<-") {
        while (line[i] === " " || line[i] === "\t") i++;
        const start = i;
        while (i < line.length && !/[\s;&|<>()]/.test(line[i] ?? "")) i++;
        heredocs.push({ word: line.slice(start, i).replace(/['"\\]/g, ""), tabs: redirect[0] === "<<-" });
        tokens.push({ kind: "redirect", op });
        tokens.push({ kind: "word", value: "" });
        continue;
      }
      tokens.push({ kind: "redirect", op });
      continue;
    }
    const op = /^(?:&&|\|\||\|&|;;|[;&|()])/.exec(line.slice(i));
    if (op) {
      end();
      tokens.push({ kind: "op", value: op[0] === ";;" ? ";" : op[0] });
      i += op[0].length;
      continue;
    }
    word += ch;
    inWord = true;
    i++;
  }
  end();
  return tokens.filter((t) => t.kind !== "op" || SEPARATORS.has(t.value));
}

/** Reads a double-quoted string from `start`, after the quote. Returns the index after the closing quote. */
function readDoubleQuoted(
  line: string,
  start: number,
  substitutions: string[],
  add: (text: string) => void,
): number {
  let i = start;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === '"') return i + 1;
    if (ch === "\\" && /["\\$`\n]/.test(line[i + 1] ?? "")) {
      add(line[i + 1] === "\n" ? "" : (line[i + 1] ?? ""));
      i += 2;
      continue;
    }
    if (ch === "`") {
      const close = findBacktick(line, i + 1);
      substitutions.push(line.slice(i + 1, close));
      add("$(...)");
      i = close + 1;
      continue;
    }
    if (ch === "$" && line[i + 1] === "(") {
      const close = findParen(line, i + 2);
      if (line[i + 2] !== "(") substitutions.push(line.slice(i + 2, close));
      add("$(...)");
      i = close + 1;
      continue;
    }
    add(ch);
    i++;
  }
  throw new ShellParseError("A double quote is not closed.");
}

function findBacktick(line: string, start: number): number {
  for (let i = start; i < line.length; i++) {
    if (line[i] === "\\") {
      i++;
      continue;
    }
    if (line[i] === "`") return i;
  }
  throw new ShellParseError("A backtick is not closed.");
}

/** The index of the `)` that closes a `$(` whose contents start at `start`. */
function findParen(line: string, start: number): number {
  let depth = 1;
  for (let i = start; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'") {
      const close = line.indexOf("'", i + 1);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (ch === '"') {
      i = readDoubleQuoted(line, i + 1, [], () => undefined) - 1;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new ShellParseError("A $( is not closed.");
}

/** Skips the bodies of pending here-documents, which start on the line after their `<<`. */
function skipHeredocs(line: string, start: number, pending: { word: string; tabs: boolean }[]): number {
  let i = start;
  while (pending.length > 0) {
    const doc = pending.shift();
    if (doc === undefined) break;
    for (;;) {
      if (i >= line.length) return i;
      const nl = line.indexOf("\n", i);
      const text = line.slice(i, nl < 0 ? line.length : nl);
      i = nl < 0 ? line.length : nl + 1;
      if ((doc.tabs ? text.replace(/^\t+/, "") : text) === doc.word) break;
    }
  }
  return i;
}
