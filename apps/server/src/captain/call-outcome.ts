/**
 * How an agent's earlier tool call ended, read from the room. A permission the captain answered and
 * whose call then succeeded is normal use, not a loop (SPEC 5.18). Pure.
 */
import type { RoomItem } from "@majhi/shared";

export type CallOutcome =
  /** The call ran and finished. */
  | { state: "ok" }
  /** The call ran and the tool returned an error. */
  | { state: "failed"; error: string }
  /** The prompt was rejected or cancelled: the call did not run. */
  | { state: "refused" };

/** The room id of the tool item a permission prompt was about: `perm:<run>:<n>` names the run. */
export function toolItemIdOf(perm: RoomItem): string | undefined {
  if (perm.type !== "permission" || perm.toolCallId === undefined) return undefined;
  const run = /^perm:([^:]+):/.exec(perm.id)?.[1];
  return run === undefined ? undefined : `tool:${perm.agent}:${run}:${perm.toolCallId}`;
}

/** How the call a permission prompt was about ended, or undefined while it is unknown or still running. */
export function callOutcome(perm: RoomItem | undefined, tool: RoomItem | undefined): CallOutcome | undefined {
  if (perm === undefined || perm.type !== "permission") return undefined;
  if (perm.state === "cancelled") return { state: "refused" };
  const chosen = perm.options.find((o) => o.id === perm.chosen)?.kind;
  if (chosen === "reject_once" || chosen === "reject_always") return { state: "refused" };
  if (tool === undefined || tool.type !== "tool") return undefined;
  if (tool.status === "completed") return { state: "ok" };
  if (tool.status !== "failed") return undefined;
  const text = tool.content.flatMap((c) =>
    c.type === "text" ? [c.text] : c.type === "terminal" ? [c.output] : [],
  );
  return { state: "failed", error: text.join(" ").replace(/\s+/g, " ").trim().slice(0, 300) };
}
