import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { TaskDockerErrorCode } from "@majhi/shared";
import { assertReadable, refuse, type Safety, shown } from "./args.ts";

/** A `.env` file of a repo is a few lines. Anything bigger is not one. */
const MAX_ENV_FILE_BYTES = 128 * 1024;

function isNameChar(c: string, first: boolean): boolean {
  const code = c.charCodeAt(0);
  const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "_";
  return first ? letter : letter || (code >= 48 && code <= 57);
}

/** `NAME` is a variable name: a letter or `_`, then letters, digits and `_`, at most 64. */
export function isEnvName(name: string): boolean {
  if (name.length === 0 || name.length > 64) return false;
  return [...name].every((c, i) => isNameChar(c, i === 0));
}

/** The value after `=`: quoted (`"a b"`, `'a b'`) or bare with an optional ` # comment`. */
function valueAfterEquals(raw: string): string {
  const text = raw.trimStart();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1);
    if (end !== -1) {
      const inner = text.slice(1, end);
      return quote === '"' ? inner.replaceAll("\\n", "\n").replaceAll('\\"', '"') : inner;
    }
  }
  const hash = text.indexOf(" #");
  return (hash === -1 ? text : text.slice(0, hash)).trimEnd();
}

/**
 * The `NAME=value` pairs of an env file's text, in order. Comments, blank lines and a leading
 * `export ` are skipped. A bare `NAME` (docker would copy it from the caller's own environment) is
 * skipped too: majhi never passes its own environment, or a runner's, to a task's container.
 */
export function parseEnvFile(text: string): string[] {
  const pairs: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const at = line.indexOf("=");
    if (at === -1) continue;
    const name = line.slice(0, at).trim();
    if (!isEnvName(name))
      refuse(`The env file has a line with the name ${shown(name)}, which is not a variable name.`);
    pairs.push(`${name}=${valueAfterEquals(line.slice(at + 1))}`);
  }
  return pairs;
}

/**
 * The pairs of an env file of the task: a path inside the task folder (symlinks followed), never
 * majhi's config folder or a protected file. A file outside is refused with `code`.
 */
export function readEnvFile(
  path: string,
  from: string,
  safety: Safety,
  outside: TaskDockerErrorCode = "env_file_outside",
): string[] {
  const absolute = resolve(from, path);
  assertReadable(absolute, safety, "env file", outside);
  let size: number;
  try {
    size = statSync(absolute).size;
  } catch {
    return refuse(`The env file ${shown(path)} does not exist.`);
  }
  if (size > MAX_ENV_FILE_BYTES) return refuse(`The env file ${shown(path)} is too big.`);
  return parseEnvFile(readFileSync(absolute, "utf8"));
}
