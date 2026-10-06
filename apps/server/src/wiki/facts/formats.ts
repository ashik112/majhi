/**
 * Small line-structured readers for the config formats that are not YAML, JSON or TOML. Each follows the
 * format's own grammar (a dotenv line, a Dockerfile instruction with its continuations, a requirements
 * line), not a search over prose.
 */

/** The parts of a line between runs of white space. */
export function splitSpaces(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      if (current !== "") out.push(current);
      current = "";
    } else current += ch;
  }
  if (current !== "") out.push(current);
  return out;
}

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based. */
  line: number;
}

/** `KEY=value` lines. Comments, blank lines and `export ` are handled; quotes are removed from the value. */
export function parseDotenv(text: string): DotenvEntry[] {
  const out: DotenvEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes(" ")) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1) {
      const end = value.indexOf(quote, 1);
      value = end < 0 ? value.slice(1) : value.slice(1, end);
    } else {
      // An unquoted value ends at a space followed by `#`.
      const comment = value.indexOf(" #");
      if (comment >= 0) value = value.slice(0, comment).trimEnd();
    }
    out.push({ key, value, line: i + 1 });
  }
  return out;
}

export interface Instruction {
  /** Upper case: `FROM`, `EXPOSE`, `ENV`. */
  name: string;
  args: string;
  /** 1-based line where the instruction starts. */
  line: number;
}

/**
 * A Dockerfile as instructions: comments and blank lines dropped, a line that ends in `\` joined with the
 * next. The first word of each is the instruction.
 */
export function parseDockerfile(text: string): Instruction[] {
  const out: Instruction[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let joined = "";
    let more = true;
    while (more && i < lines.length) {
      const raw = (lines[i] ?? "").trimEnd();
      i += 1;
      if (joined === "" && (raw.trim() === "" || raw.trimStart().startsWith("#"))) {
        more = false;
        break;
      }
      if (raw.trimStart().startsWith("#")) continue;
      if (raw.endsWith("\\")) joined += `${raw.slice(0, -1)} `;
      else {
        joined += raw;
        more = false;
      }
    }
    const trimmed = joined.trim();
    if (trimmed === "") continue;
    const [first = "", ...rest] = splitSpaces(trimmed);
    out.push({ name: first.toUpperCase(), args: rest.join(" "), line: start + 1 });
  }
  return out;
}

/** The image of the last `FROM` (the one the container runs), without `--platform` flags. */
export function finalImage(instructions: readonly Instruction[]): string | undefined {
  const froms = instructions.filter((i) => i.name === "FROM");
  const last = froms.at(-1);
  if (last === undefined) return undefined;
  const parts = splitSpaces(last.args).filter((p) => !p.startsWith("--"));
  return parts[0];
}

/** Ports of every `EXPOSE`: `3000`, `8080/tcp`, `80 443`. */
export function exposedPorts(instructions: readonly Instruction[]): { port: number; line: number }[] {
  const out: { port: number; line: number }[] = [];
  for (const ins of instructions) {
    if (ins.name !== "EXPOSE") continue;
    for (const token of splitSpaces(ins.args)) {
      const port = Number(token.split("/")[0]);
      if (Number.isInteger(port) && port > 0 && port < 65536) out.push({ port, line: ins.line });
    }
  }
  return out;
}

/** A dependency name from a PEP 508 string or a Poetry key: the leading run of name characters, normalized. */
export function pythonName(spec: string): string {
  let name = "";
  for (const ch of spec.trim()) {
    const code = ch.codePointAt(0) ?? 0;
    const ok =
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      ch === "-" ||
      ch === "_" ||
      ch === ".";
    if (!ok) break;
    name += ch;
  }
  return normalizePython(name);
}

/** PEP 503: lower case, runs of `-`, `_`, `.` are one `-`. */
export function normalizePython(name: string): string {
  let out = "";
  let dash = false;
  for (const ch of name.toLowerCase()) {
    if (ch === "-" || ch === "_" || ch === ".") {
      dash = true;
      continue;
    }
    if (dash && out !== "") out += "-";
    dash = false;
    out += ch;
  }
  return out;
}

export interface PythonRequirement {
  name: string;
  /** A git URL when the line is `name @ git+https://...` or a bare `git+https://...#egg=name`. */
  url?: string | undefined;
  raw: string;
  line: number;
}

/** The lines of a requirements file. Options (`-r`, `-e`, `--index-url`) and comments are skipped. */
export function parseRequirements(text: string): PythonRequirement[] {
  const out: PythonRequirement[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "" || raw.startsWith("#") || raw.startsWith("-")) continue;
    const comment = raw.indexOf(" #");
    const spec = (comment < 0 ? raw : raw.slice(0, comment)).trim();
    const at = spec.indexOf(" @ ");
    if (at > 0) {
      out.push({
        name: pythonName(spec.slice(0, at)),
        url: spec.slice(at + 3).trim(),
        raw: spec,
        line: i + 1,
      });
    } else if (spec.startsWith("git+")) {
      const egg = spec.indexOf("#egg=");
      out.push({ name: egg < 0 ? "" : pythonName(spec.slice(egg + 5)), url: spec, raw: spec, line: i + 1 });
    } else {
      out.push({ name: pythonName(spec), raw: spec, line: i + 1 });
    }
  }
  return out;
}
