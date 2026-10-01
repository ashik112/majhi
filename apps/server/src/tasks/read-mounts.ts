import { realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isInside } from "../editor/allowed.ts";
import { UserError } from "../errors.ts";

/** Who may read what, for one agent. */
export interface ReadPolicy {
  /** The owner's workspace roots. Nothing outside them is ever mounted. */
  roots: readonly string[];
  /** Registered projects. An org agent reads its own org's and never another's. */
  projects: readonly { path: string; org: string }[];
  /** The agent's scope: `root` for a root agent (the boss), else its org. */
  scope: string;
  /** Places no run may read: majhi's config folder, the secrets key, the owner's `.ssh`. */
  blocked: readonly string[];
  /** The tasks folder. It holds every org's task files, so only a root agent reads it. */
  tasksDir: string;
}

/** Why the path is not mounted, in words for the room. Thrown by `checkReadMount`. */
export class ReadRefused extends UserError {}

async function realOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

const overlaps = (a: string, b: string) => isInside(a, b) || isInside(b, a);

/**
 * The path to mount read-only, or a ReadRefused saying why not. It must be absolute, exist, and
 * lie inside a workspace root both by its name and by its real location (a link out is refused).
 * It must not hold or sit in majhi's own folders (the runner's mount guard checks again at start
 * and stays the final word). An org agent also gets nothing inside or holding another org's
 * project, or the tasks folder.
 */
export async function checkReadMount(path: string, policy: ReadPolicy): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) throw new ReadRefused("Give an absolute path.");
  const target = resolve(path);
  const roots = policy.roots.map((r) => resolve(r));
  if (!roots.some((r) => isInside(target, r))) {
    throw new ReadRefused(`${target} is not inside a workspace root.`);
  }
  const real = await realpath(target).catch(() => undefined);
  if (real === undefined) throw new ReadRefused(`There is nothing at ${target}.`);
  const realRoots = await Promise.all(roots.map(realOr));
  if (!realRoots.some((r) => isInside(real, r))) {
    throw new ReadRefused(`${target} leads outside the workspace roots.`);
  }
  for (const b of policy.blocked) {
    for (const form of new Set([resolve(b), await realOr(b)])) {
      if (overlaps(real, form) || overlaps(target, form)) {
        throw new ReadRefused(`${target} is not readable: it is, holds or sits in a protected folder.`);
      }
    }
  }
  if (policy.scope === "root") return target;
  const foreign = [
    { path: policy.tasksDir, label: "the tasks folder" },
    ...policy.projects
      .filter((p) => p.org !== policy.scope)
      .map((p) => ({ path: p.path, label: "another org's project" })),
  ];
  for (const f of foreign) {
    for (const form of new Set([resolve(f.path), await realOr(f.path)])) {
      if (overlaps(real, form))
        throw new ReadRefused(`${target} is not readable: it is or holds ${f.label}.`);
    }
  }
  return target;
}

/** The blocked places for a host: majhi's home, the secrets key file, `~/.ssh`. */
export function blockedPaths(host: {
  majhiHome: string;
  hostHome: string;
  protectedPaths: readonly string[];
}): string[] {
  return [host.majhiHome, join(host.hostHome, ".ssh"), ...host.protectedPaths.filter((p) => p !== "")];
}

/** A registered project, as far as read access goes. */
export interface ReadableProject {
  id: string;
  org: string;
  /** Absolute path of the checkout. */
  path: string;
}

/**
 * The registered projects an agent reads in every run: a root agent (the boss) reads all of them,
 * an org agent only its own org's. Never another org's.
 */
export function projectsFor<P extends { org: string }>(scope: string, projects: readonly P[]): P[] {
  return projects.filter((p) => scope === "root" || p.org === scope);
}
