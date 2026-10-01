import { isOwnerChat, type RoomItem, type Task } from "@majhi/shared";

export interface MentionableProject {
  id: string;
  org: string;
  /** Absolute path of the checkout. */
  path: string;
  aliases?: readonly string[] | undefined;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The words that name a project: its id and aliases, as whole words (a name inside a longer word is not a mention). */
function named(text: string, name: string): boolean {
  if (name.length < 2) return false;
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(name)}(?![A-Za-z0-9_-])`, "i").test(text);
}

/** True when `text` holds the path itself or a path inside it. */
function pathIn(text: string, path: string): boolean {
  const clean = path.replace(/\/+$/, "");
  if (clean === "") return false;
  return new RegExp(`${escapeRe(clean)}(?![A-Za-z0-9_-])`).test(text);
}

/**
 * The registered projects a chat talks about: named by id, alias or path in what the owner wrote,
 * or read by the agent (paths of its tool calls and the folders mounted for it). Sorted by id.
 */
export function mentionedProjects(
  task: Pick<Task, "kind" | "brief" | "readMounts">,
  items: readonly RoomItem[],
  projects: readonly MentionableProject[],
): string[] {
  if (!isOwnerChat(task)) return [];
  const said = items.flatMap((i) => (i.type === "owner" ? [i.text] : []));
  const read = [
    ...items.flatMap((i) => (i.type === "tool" ? [...i.locations, i.title] : [])),
    ...(task.readMounts ?? []).map((m) => m.path),
  ];
  const found = new Set<string>();
  for (const p of projects) {
    const names = [p.id, ...(p.aliases ?? [])];
    if (
      said.some((t) => names.some((n) => named(t, n)) || pathIn(t, p.path)) ||
      read.some((t) => pathIn(t, p.path))
    )
      found.add(p.id);
  }
  return [...found].sort();
}
