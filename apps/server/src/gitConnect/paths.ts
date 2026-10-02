import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { expandHome, IdSchema } from "@majhi/shared";
import { errorCode, UserError } from "../errors.ts";
import { isGitRepo } from "../git/git.ts";

/**
 * The path rule for a cloned or new project: `<root>/<org>/<folder>`. `root` is the first workspace
 * root unless the call names another one of the configured roots; `org` is the workspace id
 * (`private` for Private). Built with `path` on resolved roots, never by string concatenation.
 */
export interface ProjectPlace {
  root: string;
  /** `<root>/<org>`. */
  parent: string;
  path: string;
}

/** True when `path` is `root` or inside it, after both are resolved. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function projectPlace(input: {
  roots: readonly string[];
  hostHome: string;
  root?: string | undefined;
  org: string;
  folder: string;
}): ProjectPlace {
  const roots = input.roots.map((r) => resolve(expandHome(r, input.hostHome)));
  const first = roots[0];
  if (first === undefined) throw new UserError("Pick a project folder first.", 409);
  let root = first;
  if (input.root !== undefined) {
    const wanted = resolve(expandHome(input.root, input.hostHome));
    const found = roots.find((r) => r === wanted);
    if (found === undefined) {
      throw new UserError(`${input.root} is not one of the project folders (${roots.join(", ")}).`);
    }
    root = found;
  }
  if (!IdSchema.safeParse(input.org).success) throw new UserError("That is not a workspace id.");
  if (
    input.folder === "" ||
    input.folder.includes("/") ||
    input.folder.includes("\\") ||
    input.folder.startsWith(".")
  ) {
    throw new UserError("Use a plain folder name.");
  }
  const parent = join(root, input.org);
  const path = join(parent, input.folder);
  if (!isInside(root, path) || resolve(path) === resolve(root) || resolve(path) === resolve(parent)) {
    throw new UserError("That folder is outside the project folder.");
  }
  return { root, parent, path };
}

/** `missing`, an `empty` folder, or `taken` (a file, or a folder with anything in it). */
export async function targetState(path: string): Promise<"missing" | "empty" | "taken"> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) return "taken";
    return (await readdir(path)).length === 0 ? "empty" : "taken";
  } catch (err) {
    if (errorCode(err) === "ENOENT") return "missing";
    throw err;
  }
}

/** Refuses a target that is not empty, or a workspace folder that is itself a repo. */
export async function checkPlace(place: ProjectPlace): Promise<"missing" | "empty"> {
  if (await isGitRepo(place.parent)) {
    throw new UserError(`${place.parent} is itself a git repo. majhi will not put a repo inside it.`, 409);
  }
  const state = await targetState(place.path);
  if (state === "taken") {
    throw new UserError(`${place.path} already exists and is not empty. Pick another folder name.`, 409);
  }
  return state;
}

/** A project id from a folder name, made unique against `taken`. */
export function projectIdFor(folder: string, taken: ReadonlySet<string>): string {
  const base =
    folder
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "project";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}
