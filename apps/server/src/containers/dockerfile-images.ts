import { ImageRefSchema } from "@majhi/shared";
import { refuse, shown } from "./args.ts";
import { interpolate } from "./compose.ts";

/**
 * The images a Dockerfile pulls: every `FROM`, every `COPY --from` and `RUN --mount ... from=` that
 * names an image rather than an earlier stage, and the `# syntax=` frontend. A task's build may use
 * only images the owner allowed or the task built itself, the same list `docker run` obeys, so a
 * Dockerfile cannot pull what the owner never saw. Read from the text, never run.
 */

/** A Dockerfile line with its continuation lines joined, and where it started. */
function logicalLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (current === "" && (line.trim() === "" || line.trim().startsWith("#"))) {
      lines.push(line.trim());
      continue;
    }
    // A comment line inside a continued instruction is dropped, as Docker does.
    if (current !== "" && line.trim().startsWith("#")) continue;
    if (line.endsWith("\\")) {
      current += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(`${current}${line}`.trim());
    current = "";
  }
  if (current !== "") lines.push(current.trim());
  return lines;
}

/** The `key=value` of a parser directive comment (`# syntax=docker/dockerfile:1`), or undefined. */
function directive(line: string): [string, string] | undefined {
  if (!line.startsWith("#")) return undefined;
  const body = line.slice(1).trim();
  const at = body.indexOf("=");
  if (at < 1) return undefined;
  const key = body.slice(0, at).trim().toLowerCase();
  return [...key].every((c) => c >= "a" && c <= "z") ? [key, body.slice(at + 1).trim()] : undefined;
}

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => w !== "");
}

const isDigits = (text: string): boolean => text !== "" && [...text].every((c) => c >= "0" && c <= "9");
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
  const lines = logicalLines(text);
  const images = new Set<string>();
  const stages = new Set<string>();
  const vars = new Map<string, string>();
  let seenInstruction = false;
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
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      const found = seenInstruction ? undefined : directive(line);
      if (found?.[0] === "syntax" && found[1] !== "") add(found[1], "The # syntax= frontend");
      continue;
    }
    seenInstruction = true;
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
