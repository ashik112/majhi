import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkspacesUpdate } from "@majhi/shared";
import { type Document, isCollection, isMap, isNode, isScalar, parseDocument } from "yaml";
import { errorCode } from "../errors.ts";

/** majhi.yaml cannot be edited safely, for example because it has YAML syntax errors. */
export class ConfigConflictError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Sets `workspaces` and `tasks_dir` in majhi.yaml and leaves every other key,
 * and the comments the yaml library can keep, as they were. An omitted
 * `tasks_dir` is removed, so the default applies.
 */
export async function writeWorkspaces(file: string, update: WorkspacesUpdate): Promise<void> {
  const text = await readFile(file, "utf8").catch((err: unknown) => {
    if (errorCode(err) === "ENOENT") return "";
    throw err;
  });
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ConfigConflictError(
      "majhi.yaml has YAML errors. Fix them by hand first.",
      doc.errors.map((e) => e.message.split("\n", 1)[0] ?? e.message),
    );
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new ConfigConflictError("majhi.yaml must be a map of settings at the top level.");
  }

  setKeepingStyle(doc, "workspaces", update.workspaces);
  if (update.tasks_dir === undefined) doc.delete("tasks_dir");
  else setKeepingStyle(doc, "tasks_dir", update.tasks_dir);

  await writeAtomically(file, doc.toString());
}

/** Replaces a top-level value, keeping the old node's comments and flow style. Skips equal values. */
function setKeepingStyle(doc: Document, key: string, value: string | string[]): void {
  const old: unknown = doc.get(key, true);
  if (isNode(old) && JSON.stringify(old.toJSON()) === JSON.stringify(value)) return;
  const node = doc.createNode(value);
  if (isNode(old)) {
    node.comment = old.comment ?? null;
    node.commentBefore = old.commentBefore ?? null;
    if (isCollection(old) && isCollection(node)) node.flow = old.flow ?? false;
    if (isScalar(old) && isScalar(node) && old.type !== undefined) node.type = old.type;
  }
  doc.set(key, node);
}

/** Writes through a temp file so a reader never sees half a file. Follows a symlinked majhi.yaml. */
async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const target = await realpath(file).catch(() => file);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content);
  await rename(temp, target);
}
