/**
 * What a check reports as wrong, read from the tool's own output, so a failure can be compared with the
 * same check on another commit. Lint and type check problems are `file:rule` or `file:code:message`
 * (never a line number, which moves when code above it changes); tests are the names the runner prints
 * for its failures. A build has no problems of its own: it passes or fails. `undefined` means the
 * output was not understood, and the comparison then rests on pass or fail alone.
 */

export type ProblemKind = "lint" | "typecheck" | "test" | "build";

/** Output without colour codes. */
export function plain(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] ?? "";
    if (c === "\u001b" && text[i + 1] === "[") {
      i += 2;
      while (i < text.length && !((text[i] ?? "") >= "@" && (text[i] ?? "") <= "~")) i++;
      continue;
    }
    out += c;
  }
  return out;
}

const isDigits = (s: string): boolean => s !== "" && [...s].every((c) => c >= "0" && c <= "9");

/** A path-like first word: no spaces, and a folder or an extension in it. */
const looksLikePath = (line: string): boolean =>
  line !== "" && !line.includes(" ") && (line.includes("/") || line.includes(".")) && !line.endsWith(":");

/** `12:5  error  message  rule-name`: the parts of an ESLint line, or undefined. */
function eslintLine(
  line: string,
): { severity: string; message: string; rule: string | undefined } | undefined {
  if (!line.startsWith("  ")) return undefined;
  const words = line
    .trim()
    .split("  ")
    .filter((w) => w.trim() !== "")
    .map((w) => w.trim());
  const position = words[0] ?? "";
  const [row, col] = position.split(":");
  if (row === undefined || col === undefined || !isDigits(row) || !isDigits(col)) return undefined;
  const severity = words[1];
  if (severity !== "error" && severity !== "warning") return undefined;
  const rest = words.slice(2);
  const last = rest.at(-1);
  const rule = rest.length >= 2 && last !== undefined && !last.includes(" ") ? last : undefined;
  return { severity, message: (rule === undefined ? rest : rest.slice(0, -1)).join(" "), rule };
}

/** `path:12:5: message` or `path:12: message`: a diagnostic of most compilers and linters. */
function colonLine(line: string): string | undefined {
  const first = line.indexOf(":");
  if (first <= 0 || line.startsWith(" ")) return undefined;
  const path = line.slice(0, first);
  if (path.includes(" ") || !(path.includes("/") || path.includes("."))) return undefined;
  const parts = line.slice(first + 1).split(":");
  if (!isDigits(parts[0] ?? "")) return undefined;
  const hasCol = isDigits(parts[1] ?? "");
  const rest = parts
    .slice(hasCol ? 2 : 1)
    .join(":")
    .trim();
  return rest === "" ? undefined : `${path}:${rest}`;
}

/** `path(12,5): error TS2322: message` and `path:12:5 - error TS2322: message`. */
function tscLine(line: string): string | undefined {
  const at = line.indexOf("error TS");
  if (at < 0) return undefined;
  const open = line.indexOf("(");
  const colon = line.indexOf(":");
  const pathEnd = open > 0 && (colon < 0 || open < colon) ? open : colon;
  if (pathEnd <= 0 || pathEnd > at) return undefined;
  const path = line.slice(0, pathEnd);
  if (path.includes(" ")) return undefined;
  const rest = line.slice(at + "error ".length);
  return `${path}:${rest.trim()}`;
}

function diagnostics(text: string): string[] {
  const out = new Set<string>();
  let file: string | undefined;
  for (const raw of plain(text).split("\n")) {
    const line = raw.trimEnd();
    const tsc = tscLine(line);
    if (tsc !== undefined) {
      out.add(tsc);
      continue;
    }
    const es = eslintLine(line);
    if (es !== undefined) {
      if (file !== undefined && es.severity === "error") out.add(`${file}:${es.rule ?? es.message}`);
      continue;
    }
    const colon = colonLine(line);
    if (colon !== undefined) {
      out.add(colon);
      continue;
    }
    file = looksLikePath(line) ? line : undefined;
  }
  return [...out].sort();
}

/** The names of the tests a runner reports as failed. */
function failedTests(text: string): string[] {
  const out = new Set<string>();
  for (const raw of plain(text).split("\n")) {
    const line = raw.trim();
    if (line.startsWith("FAIL ")) out.add(line.slice(5).trim());
    else if (line.startsWith("● ") && !line.includes("›  ")) out.add(line.slice(2).trim());
    else if (line.startsWith("FAILED ")) out.add((line.slice(7).split(" - ")[0] ?? "").trim());
    else if (line.startsWith("--- FAIL: ")) out.add((line.slice(10).split(" ")[0] ?? "").trim());
    else if (line.startsWith("test ") && line.endsWith("... FAILED"))
      out.add(line.slice(5, -"... FAILED".length).trim());
    else if (line.startsWith("× ") || line.startsWith("✗ ") || line.startsWith("✕ "))
      out.add(line.slice(2).trim());
  }
  out.delete("");
  return [...out].sort();
}

/** The problems a failed check reported. Undefined when this tool's output is not understood or holds none. */
export function problemsOf(kind: ProblemKind, output: string): string[] | undefined {
  if (kind === "build") return undefined;
  const found = kind === "test" ? failedTests(output) : diagnostics(output);
  return found.length === 0 ? undefined : found;
}

export interface Comparison {
  /** Problems the task's code has that the base does not. Empty when the check only fails because the base does. */
  fresh: string[];
  /** Problems the base already had. */
  existing: string[];
  /** `problems`: compared one by one. `result`: the output was not understood, so only pass or fail was compared. */
  by: "problems" | "result";
}

/**
 * The task's failure against the same check on the base commit. A base that passed makes every failure
 * new. When the base failed too, a failure counts as new only when it holds a problem the base does
 * not; output that cannot be read counts as the same failure.
 */
export function compareFailures(
  kind: ProblemKind,
  head: string,
  base: { passed: boolean; problems: string[] | undefined },
): Comparison {
  const headProblems = problemsOf(kind, head);
  if (base.passed)
    return {
      fresh: headProblems ?? [],
      existing: [],
      by: headProblems === undefined ? "result" : "problems",
    };
  const baseProblems = base.problems;
  if (headProblems === undefined || baseProblems === undefined)
    return { fresh: [], existing: baseProblems ?? [], by: "result" };
  const known = new Set(baseProblems);
  return {
    fresh: headProblems.filter((p) => !known.has(p)),
    existing: headProblems.filter((p) => known.has(p)),
    by: "problems",
  };
}
