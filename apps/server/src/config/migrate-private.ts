import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LEGACY_PERSONAL, PRIVATE } from "@majhi/shared";
import { type Document, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { errorCode } from "../errors.ts";
import { CONFIG_FILE_NAME } from "./load.ts";

/** Summary of the config commit that renames the org. Shows in History with Undo. */
export const RENAME_PRIVATE_SUMMARY = "Rename the Personal org to Private";

const AGENTS_DIR = "agents";

export interface PlannedWrite {
  path: string;
  text: string;
}

/** Points at `private` instead of `personal`. Returns true when something changed. */
function renameIn(doc: Document, path: readonly (string | number)[]): boolean {
  const node = doc.getIn([...path], true);
  if (!isScalar(node) || node.value !== LEGACY_PERSONAL) return false;
  node.value = PRIVATE;
  return true;
}

function renameInMajhiYaml(text: string): string | undefined {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return undefined;
  let changed = false;
  for (const section of ["accounts", "projects"]) {
    const map = doc.get(section, true);
    if (!isMap(map)) continue;
    for (const pair of map.items) {
      if (isScalar(pair.key)) changed = renameIn(doc, [section, String(pair.key.value), "org"]) || changed;
    }
  }
  return changed ? doc.toString() : undefined;
}

/** Frontmatter `scope` and `where` of one agent file. Returns the new text, or undefined when nothing changes. */
function renameInAgentFile(text: string): string | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === "---");
  if (end === -1) return undefined;
  const doc = parseDocument(lines.slice(1, end).join("\n"));
  if (doc.errors.length > 0) return undefined;
  let changed = renameIn(doc, ["scope"]);
  const where = doc.get("where", true);
  if (isSeq(where)) {
    for (let i = 0; i < where.items.length; i++) changed = renameIn(doc, ["where", i]) || changed;
  }
  if (!changed) return undefined;
  return [lines[0], doc.toString().replace(/\n$/, ""), ...lines.slice(end)].join("\n");
}

async function readIfThere(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The file rewrites that move every reference to the old `personal` org (accounts, projects,
 * agent `scope` and `where`) to `private`. Empty when there is nothing to rename. Reads only.
 */
export async function planPrivateRename(majhiHome: string): Promise<PlannedWrite[]> {
  const out: PlannedWrite[] = [];
  const file = join(majhiHome, CONFIG_FILE_NAME);
  const yaml = await readIfThere(file);
  const nextYaml = yaml === undefined ? undefined : renameInMajhiYaml(yaml);
  if (nextYaml !== undefined) out.push({ path: file, text: nextYaml });
  const dir = join(majhiHome, AGENTS_DIR);
  const names = await readdir(dir).catch((err: unknown) => {
    if (errorCode(err) === "ENOENT") return [] as string[];
    throw err;
  });
  for (const name of names.filter((n) => n.endsWith(".md")).sort()) {
    const path = join(dir, name);
    const text = await readIfThere(path);
    const next = text === undefined ? undefined : renameInAgentFile(text);
    if (next !== undefined) out.push({ path, text: next });
  }
  return out;
}

export async function applyWrites(writes: readonly PlannedWrite[]): Promise<void> {
  for (const w of writes) await writeFile(w.path, w.text);
}
