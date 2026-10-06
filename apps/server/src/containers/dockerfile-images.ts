import { ImageRefSchema } from "@majhi/shared";
import { refuse, shown } from "./args.ts";
import { interpolate } from "./compose.ts";

/**
 * The images a Dockerfile pulls: every `FROM`, every `COPY --from` and `RUN --mount ... from=` that
 * names an image rather than an earlier stage, and the `# syntax=` frontend. A task's build may use
 * only images the owner allowed or the task built itself, the same list `docker run` obeys, so a
 * Dockerfile cannot pull what the owner never saw. Read from the text, never run.
 */

/** BuildKit's blanks: no other character splits a word or counts as leading space. */
const BLANKS = " \t\v\f\r";
const isBlank = (c: string | undefined): boolean => c !== undefined && BLANKS.includes(c);
const trimLeft = (line: string): string => {
  let at = 0;
  while (isBlank(line[at])) at++;
  return line.slice(at);
};

/** The lines of a Dockerfile as BuildKit reads them, the first one without a byte order mark. */
function rawLines(text: string): string[] {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines[0]?.startsWith("\uFEFF") === true) lines[0] = lines[0].slice(1);
  return lines;
}

/** A continued line without its escape character and the blanks after it, and whether it goes on. */
function continued(line: string, escape: string): { text: string; goes: boolean } {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line[end - 1] === escape
    ? { text: line.slice(0, end - 1), goes: true }
    : { text: line, goes: false };
}

/**
 * The instructions of a Dockerfile, each on one line, joined as BuildKit joins them (the escape
 * character, blanks after it, no space added). Comment lines and empty lines go, inside a continued
 * instruction too. A line read differently from BuildKit would hide an instruction from the check.
 */
function instructions(lines: readonly string[], escape: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = trimLeft(lines[i] ?? "");
    if (first === "" || first.startsWith("#")) continue;
    let step = continued(first, escape);
    let joined = step.text;
    while (step.goes && i + 1 < lines.length) {
      const next = lines[++i] ?? "";
      const bare = trimLeft(next);
      if (bare === "" || bare.startsWith("#")) continue;
      step = continued(next, escape);
      joined += step.text;
    }
    out.push(joined.trim());
  }
  return out;
}

const isLetter = (c: string | undefined): boolean =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** The `key=value` of a parser directive comment (`# syntax=docker/dockerfile:1`), or undefined. */
function directive(line: string): [string, string] | undefined {
  const bare = trimLeft(line);
  if (!bare.startsWith("#")) return undefined;
  const body = trimLeft(bare.slice(1));
  let at = 0;
  if (!isLetter(body[0])) return undefined;
  while (isLetter(body[at]) || isDigit(body[at])) at++;
  const key = body.slice(0, at).toLowerCase();
  let rest = trimLeft(body.slice(at));
  if (!rest.startsWith("=")) return undefined;
  rest = trimLeft(rest.slice(1)).trimEnd();
  return rest === "" ? undefined : [key, rest];
}

const DIRECTIVES = new Set(["syntax", "escape", "check"]);

/**
 * The parser directives at the top of the file, where BuildKit looks for them until the first line
 * that is not one. Only `syntax`, `escape` and `check` exist; another key is refused instead of
 * guessed at, and so is a repeated one or an escape character that is not a backslash or a backtick.
 */
function parserDirectives(lines: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of lines) {
    const one = directive(line);
    if (one === undefined) break;
    const [key, value] = one;
    if (!DIRECTIVES.has(key))
      refuse(`The parser directive ${shown(key)} is not allowed. Only syntax, escape and check are.`);
    if (found.has(key)) refuse(`The parser directive ${key} is set twice.`);
    if (key === "escape" && value !== "\\" && value !== "`")
      refuse("The escape directive is a backslash or a backtick.");
    found.set(key, value);
  }
  return found;
}

function words(text: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const c of text) {
    if (isBlank(c)) {
      if (word !== "") out.push(word);
      word = "";
    } else word += c;
  }
  if (word !== "") out.push(word);
  return out;
}

const isDigits = (text: string): boolean => text !== "" && [...text].every(isDigit);
const unquoted = (text: string): string =>
  text.length > 1 && (text[0] === '"' || text[0] === "'") && text.endsWith(text[0] ?? "")
    ? text.slice(1, -1)
    : text;

/**
 * The image references of a Dockerfile, once each. `buildArgs` are the `--build-arg` values of the
 * build, which win over an `ARG` default. A reference that cannot be resolved (a variable nothing
 * sets) is refused: it could be anything.
 */
export function dockerfileImages(text: string, buildArgs: ReadonlyMap<string, string>): string[] {
  const raw = rawLines(text);
  const directives = parserDirectives(raw);
  const lines = instructions(raw, directives.get("escape") ?? "\\");
  const images = new Set<string>();
  const stages = new Set<string>();
  const vars = new Map<string, string>();
  let stageCount = 0;
  const resolved = (ref: string, where: string): string => {
    const value = interpolate(ref, vars);
    if (value === "")
      return refuse(`${where} ${shown(ref)} is not an image majhi can read.`, "image_not_allowed");
    return value;
  };
  const add = (ref: string, where: string) => {
    const value = resolved(ref, where);
    if (value.toLowerCase() === "scratch" || stages.has(value.toLowerCase())) return;
    if (!ImageRefSchema.safeParse(value).success) {
      refuse(`${where} ${shown(value)} is not an image reference.`, "image_not_allowed");
    }
    images.add(value);
  };
  const frontend = directives.get("syntax");
  if (frontend !== undefined) add(frontend, "The # syntax= frontend");
  for (const line of lines) {
    const [first = "", ...rest] = words(line);
    const instruction = first.toUpperCase();
    const body = line.slice(first.length).trim();
    if (instruction === "ARG" && stageCount === 0) {
      for (const spec of rest) {
        const at = spec.indexOf("=");
        const name = at === -1 ? spec : spec.slice(0, at);
        const fromBuild = buildArgs.get(name);
        if (fromBuild !== undefined) vars.set(name, fromBuild);
        else if (at !== -1) vars.set(name, interpolate(unquoted(spec.slice(at + 1)), vars));
      }
    } else if (instruction === "FROM") {
      stageCount++;
      const parts = words(body).filter((w) => !w.startsWith("--"));
      const [ref, as, name] = parts;
      if (ref === undefined) refuse("A FROM names no image.", "image_not_allowed");
      else add(ref, "The FROM");
      if (as?.toUpperCase() === "AS" && name !== undefined) stages.add(interpolate(name, vars).toLowerCase());
    } else if (instruction === "COPY" || instruction === "ADD") {
      for (const w of words(body)) {
        if (!w.toLowerCase().startsWith("--from=")) continue;
        const target = w.slice("--from=".length);
        if (target !== "" && !isDigits(target)) add(target, "The COPY --from");
      }
    } else if (instruction === "RUN") {
      for (const w of words(body)) {
        if (!w.toLowerCase().startsWith("--mount=")) continue;
        for (const field of w.slice("--mount=".length).split(",")) {
          if (field.toLowerCase().startsWith("from=")) {
            const target = field.slice("from=".length);
            if (target !== "" && !isDigits(target)) add(target, "The RUN --mount from=");
          }
        }
      }
    }
  }
  return [...images];
}
