import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { PermissionAsk } from "@majhi/acp";
import { isInside } from "../fs.ts";
import { type Decider, handlerOf, type SessionDecision } from "../rooms/session-decision.ts";
import { mcpToolOf } from "../runs/permissions.ts";

/**
 * The ACP tool kinds a read-only session may use: looking at a file and searching files. Everything
 * else is refused: edit, delete, move, execute, fetch, switching mode, `other` (every MCP tool), and a
 * request that names no kind. The one MCP server a session may use is its own `files` server (below).
 */
export const READ_ONLY_KINDS: readonly string[] = ["read", "search"];

/** What the handler answers a request, before it picks an option id. */
export type ReadOnlyDecision = SessionDecision;

/** What an agent with no read tool of its own reads: it is told this when it tries a shell command. */
export const FILES_TOOLS_HINT = "Read with the files tools: read, list, search.";

/** The real path, so a link inside the folder that leads out of it is judged by where it leads. */
async function realOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Where `path` really leads (a relative path is the session's folder `root`; an absolute one may be any
 * folder) and whether that lies inside `root` or one of `also`. A link inside the folder that leads out is
 * judged by where it leads, so `..`, an absolute path and such a link are all outside. `exists` is false when
 * the path does not resolve: `real` is then the path as written, which is judged all the same.
 * The one containment of a read-only session: the permission decision and the `files` tools both use it.
 */
export async function containment(
  path: string,
  root: string,
  also: readonly string[] = [],
): Promise<{ real: string; inside: boolean; exists: boolean }> {
  const bases = await Promise.all([root, ...also].map((r) => realOr(resolve(r))));
  const wanted = resolve(root, path);
  let real = wanted;
  let exists = true;
  try {
    real = await realpath(wanted);
  } catch {
    exists = false;
  }
  return { real, inside: bases.some((b) => isInside(real, b)), exists };
}

/**
 * Decides one request of a session that may read the files under `root` and nothing else. A request
 * must name where it reads: one that names no place is refused, since the runner also mounts the
 * agent's own account home and a repo can hold links that lead there. With `files` (the name of the
 * session's own `files` server) a call of that server is allowed: its tools judge their own paths with
 * `containment`, and a shell command is refused with the way to read instead.
 */
export async function readOnlyDecision(
  ask: PermissionAsk,
  root: string,
  also: readonly string[] = [],
  files?: string,
): Promise<ReadOnlyDecision> {
  if (files !== undefined) {
    if (mcpToolOf(ask.title)?.server === files) return { allow: true };
    if (ask.kind === "execute") return { allow: false, why: `No shell in this session. ${FILES_TOOLS_HINT}` };
  }
  if (ask.kind === undefined || !READ_ONLY_KINDS.includes(ask.kind)) {
    return {
      allow: false,
      why: `A read-only session may not use ${ask.kind === undefined ? "that tool" : `${ask.kind} tools`}.${files === undefined ? "" : ` ${FILES_TOOLS_HINT}`}`,
    };
  }
  const locations = ask.locations ?? [];
  if (locations.length === 0) return { allow: false, why: "Name the file or folder to read." };
  for (const l of locations) {
    // A relative location is the session's folder; an absolute one may be any of the folders it may read. It is judged by where it really leads.
    if (!(await containment(l, root, also)).inside) {
      return { allow: false, why: `${l} is outside the folders it may read.` };
    }
  }
  return { allow: true };
}

/** The rule of a read-only session over `root` and `also`, for the permission handler and for Codex's hook. */
export function readOnlyDecider(root: string, also: readonly string[] = [], files?: string): Decider {
  return (ask) => readOnlyDecision(ask, root, also, files);
}

/**
 * The permission handler of a read-only session: allows a read or a search inside `root` once, and
 * rejects everything else, so the agent is told no and carries on. An ask with no option of the right
 * kind is cancelled.
 */
export function readOnlyHandler(
  root: string,
  also: readonly string[] = [],
  files?: string,
): (ask: PermissionAsk) => Promise<string | undefined> {
  return handlerOf(readOnlyDecider(root, also, files));
}
