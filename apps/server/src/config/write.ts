import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountConfig, OrgConfig, WorkspacesUpdate } from "@majhi/shared";
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
 * Reads majhi.yaml, lets `edit` change the document, and writes it back
 * atomically. Keys and comments the edit does not touch stay as they were.
 * A missing file starts empty.
 */
async function editConfig(file: string, edit: (doc: Document) => void): Promise<void> {
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
  edit(doc);
  await writeAtomically(file, doc.toString());
}

/**
 * Sets `workspaces` and `tasks_dir` in majhi.yaml and leaves every other key,
 * and the comments the yaml library can keep, as they were. An omitted
 * `tasks_dir` is removed, so the default applies.
 */
export function writeWorkspaces(file: string, update: WorkspacesUpdate): Promise<void> {
  return editConfig(file, (doc) => {
    setKeepingStyle(doc, "workspaces", update.workspaces);
    if (update.tasks_dir === undefined) doc.delete("tasks_dir");
    else setKeepingStyle(doc, "tasks_dir", update.tasks_dir);
  });
}

/** Adds or replaces `orgs.<id>`. */
export function writeOrg(file: string, id: string, org: OrgConfig): Promise<void> {
  return editConfig(file, (doc) => doc.setIn(["orgs", id], doc.createNode(org)));
}

/** Adds or replaces `accounts.<id>`. */
export function writeAccount(file: string, id: string, account: AccountConfig): Promise<void> {
  return editConfig(file, (doc) => doc.setIn(["accounts", id], doc.createNode(account)));
}

/** Removes `accounts.<id>`, and the `accounts` key when it is left empty. */
export function removeAccountEntry(file: string, id: string): Promise<void> {
  return editConfig(file, (doc) => {
    doc.deleteIn(["accounts", id]);
    const accounts: unknown = doc.get("accounts", true);
    if (isMap(accounts) && accounts.items.length === 0) doc.delete("accounts");
  });
}

/** Sets `boss`. */
export function writeBoss(file: string, id: string): Promise<void> {
  return editConfig(file, (doc) => doc.set("boss", id));
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
