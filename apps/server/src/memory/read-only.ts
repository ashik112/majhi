import { resolve } from "node:path";
import type { PermissionAsk } from "@majhi/acp";
import { isInside } from "../editor/allowed.ts";

/**
 * The ACP tool kinds a read-only session may use: looking at a file and searching files. Everything
 * else is refused: edit, delete, move, execute, fetch, switching mode, `other` (every MCP tool), and a
 * request that names no kind.
 */
export const READ_ONLY_KINDS: readonly string[] = ["read", "search"];

/** What the handler answers a request, before it picks an option id. */
export type ReadOnlyDecision = { allow: true } | { allow: false; why: string };

/** Decides one request of a session that may read the files under `root` and nothing else. Pure. */
export function readOnlyDecision(ask: PermissionAsk, root: string): ReadOnlyDecision {
  if (ask.kind === undefined || !READ_ONLY_KINDS.includes(ask.kind)) {
    return { allow: false, why: `A read-only session may not use a ${ask.kind ?? "tool of no kind"} tool.` };
  }
  const outside = ask.locations?.find((l) => !isInside(resolve(root, l), resolve(root)));
  if (outside !== undefined) return { allow: false, why: `${outside} is outside the folder it may read.` };
  return { allow: true };
}

/**
 * The permission handler of a read-only session: allows a read or a search inside `root` once, and
 * rejects everything else, so the agent is told no and carries on. An ask with no option of the right
 * kind is cancelled.
 */
export function readOnlyHandler(root: string): (ask: PermissionAsk) => Promise<string | undefined> {
  return async (ask) => {
    const wanted = readOnlyDecision(ask, root).allow ? ["allow_once"] : ["reject_once", "reject_always"];
    for (const kind of wanted) {
      const option = ask.options.find((o) => o.kind === kind);
      if (option !== undefined) return option.id;
    }
    return undefined;
  };
}
