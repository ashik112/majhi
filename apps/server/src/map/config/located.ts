import { isMap, isScalar, isSeq, LineCounter, type Node, parseAllDocuments, parseDocument } from "yaml";

/**
 * A YAML or JSON file read with a real parser, with the line of every key. JSON is YAML, so one parser
 * serves package.json, compose files and Kubernetes manifests; the line counter gives the proof its
 * line number. A file that does not parse reads as missing: the config pass never guesses.
 */

export interface Located {
  data: unknown;
  /** The 1-based line of the key or item at `path` (`["services", "api", "image"]`), when it exists. */
  lineOf(path: readonly (string | number)[]): number | undefined;
}

function locate(root: unknown, lines: LineCounter): Located["lineOf"] {
  return (path) => {
    let node: unknown = root;
    let at: number | undefined;
    for (const step of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(step));
        if (pair === undefined) return undefined;
        const keyAt = isScalar(pair.key) ? (pair.key.range?.[0] ?? undefined) : undefined;
        at = keyAt;
        node = pair.value;
      } else if (isSeq(node) && typeof step === "number") {
        const item: unknown = node.items[step];
        if (item === undefined) return undefined;
        const range = (item as Node).range;
        at = range?.[0] ?? at;
        node = item;
      } else {
        return undefined;
      }
    }
    return at === undefined ? undefined : lines.linePos(at).line;
  };
}

/** One document. Undefined when the text has errors. */
export function readLocated(text: string): Located | undefined {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, prettyErrors: false });
  if (doc.errors.length > 0) return undefined;
  return { data: doc.toJS(), lineOf: locate(doc.contents, lines) };
}

/** Every document of a file (Kubernetes manifests hold several). Documents with errors are left out. */
export function readAllLocated(text: string): Located[] {
  const lines = new LineCounter();
  const out: Located[] = [];
  for (const doc of parseAllDocuments(text, { lineCounter: lines, prettyErrors: false })) {
    if (doc.errors.length > 0) continue;
    out.push({ data: doc.toJS(), lineOf: locate(doc.contents, lines) });
  }
  return out;
}

/** The text of one 1-based line, trimmed and cut for an excerpt. */
export function lineText(text: string, line: number, max = 200): string {
  const raw = text.split("\n")[line - 1] ?? "";
  const trimmed = raw.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** The first 1-based line that contains `needle`, from line `from`. A fallback when no key line is known. */
export function lineContaining(text: string, needle: string, from = 1): number | undefined {
  const lines = text.split("\n");
  for (let i = Math.max(0, from - 1); i < lines.length; i++) {
    if ((lines[i] ?? "").includes(needle)) return i + 1;
  }
  return undefined;
}
