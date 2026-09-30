import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AccountConfig, OrgConfig, Price, ProjectConfig, WorkspacesUpdate } from "@majhi/shared";
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

/** Adds or replaces `projects.<id>`. */
export function writeProject(file: string, id: string, project: ProjectConfig): Promise<void> {
  return editConfig(file, (doc) => doc.setIn(["projects", id], doc.createNode(project)));
}

/** Removes `projects.<id>`, and the `projects` key when it is left empty. */
export function removeProjectEntry(file: string, id: string): Promise<void> {
  return editConfig(file, (doc) => {
    doc.deleteIn(["projects", id]);
    const projects: unknown = doc.get("projects", true);
    if (isMap(projects) && projects.items.length === 0) doc.delete("projects");
  });
}

/**
 * Sets the given fields of `context`, `limits`, `resume`, `rooms`, `policy`, `decisions` and `memory`, and nothing else. A policy
 * `commands` map replaces the old one; an empty map removes the key.
 */
export function writeSettings(
  file: string,
  patch: Partial<
    Record<"context" | "limits" | "resume" | "rooms" | "policy" | "decisions" | "memory", object | undefined>
  >,
): Promise<void> {
  return editConfig(file, (doc) => {
    for (const [section, fields] of Object.entries(patch)) {
      for (const [key, value] of Object.entries((fields ?? {}) as Record<string, unknown>)) {
        if (value === undefined) continue;
        if (value === null) {
          doc.deleteIn([section, key]);
          continue;
        }
        const empty = typeof value === "object" && value !== null && Object.keys(value).length === 0;
        if (empty) doc.deleteIn([section, key]);
        else doc.setIn([section, key], doc.createNode(value));
      }
    }
  });
}

/** Sets `prices.<model>`, or removes it with null, and the `prices` key when it is left empty. */
export function writePrice(file: string, model: string, price: Price | null): Promise<void> {
  return editConfig(file, (doc) => {
    if (price === null) doc.deleteIn(["prices", model]);
    else doc.setIn(["prices", model], doc.createNode(price));
    const prices: unknown = doc.get("prices", true);
    if (isMap(prices) && prices.items.length === 0) doc.delete("prices");
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

/** Points `boss`, `decisions.acp_agent` and `memory.housekeeper` at the new id when they name the old one. */
export function renameAgentInConfig(file: string, id: string, newId: string): Promise<void> {
  return editConfig(file, (doc) => {
    if (doc.get("boss") === id) doc.set("boss", newId);
    if (doc.getIn(["decisions", "acp_agent"]) === id) doc.setIn(["decisions", "acp_agent"], newId);
    if (doc.getIn(["memory", "housekeeper"]) === id) doc.setIn(["memory", "housekeeper"], newId);
  });
}

/** Renames the `orgs` key and the `org` of every account and project that names it, in place. */
export function renameOrgInConfig(file: string, id: string, newId: string): Promise<void> {
  return editConfig(file, (doc) => {
    const orgs: unknown = doc.get("orgs", true);
    if (isMap(orgs)) {
      for (const pair of orgs.items) {
        if (isScalar(pair.key) && pair.key.value === id) pair.key.value = newId;
      }
    }
    for (const section of ["accounts", "projects"]) {
      const map: unknown = doc.get(section, true);
      if (!isMap(map)) continue;
      for (const pair of map.items) {
        if (isMap(pair.value) && pair.value.get("org") === id) pair.value.set("org", newId);
      }
    }
  });
}
