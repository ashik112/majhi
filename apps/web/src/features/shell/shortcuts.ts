import { PAGE_PATH, type PagePath } from "../../lib/pages";

export type GoTarget = PagePath;

/** `g` then one of these keys goes to a page. */
export const GO_KEYS: Record<string, GoTarget> = {
  b: PAGE_PATH.board,
  a: PAGE_PATH.agents,
  h: PAGE_PATH.usage,
  k: PAGE_PATH.skills,
  s: PAGE_PATH.setup,
  p: PAGE_PATH.projects,
  o: PAGE_PATH.orgs,
};

export interface Shortcut {
  keys: string;
  what: string;
}

export const SHORTCUTS: readonly Shortcut[] = [
  { keys: "n", what: "New task" },
  { keys: "g b", what: "Go to the board" },
  { keys: "g a", what: "Go to agents" },
  { keys: "g h", what: "Go to health and usage" },
  { keys: "g k", what: "Go to skills" },
  { keys: "g s", what: "Go to hub setup" },
  { keys: "g p", what: "Go to projects and links" },
  { keys: "g o", what: "Go to orgs and accounts" },
  { keys: "j k h l", what: "Move between cards on the board (arrows too)" },
  { keys: "Enter", what: "Open the card you are on" },
  { keys: "Esc", what: "Stop the agent in an open task" },
  { keys: "?", what: "Show this list" },
];

/** How long after `g` the second key still counts. */
export const CHORD_MS = 1200;

export type ShortcutAction =
  | { type: "go"; to: GoTarget }
  | { type: "new-task" }
  | { type: "help" }
  | { type: "wait-for-go" }
  | { type: "none" };

export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing: boolean;
}

/**
 * What a key press does, given whether `g` was pressed a moment ago. The caller has already
 * skipped presses inside fields, dialogs and menus.
 */
export function resolveShortcut(event: ShortcutKey, afterG: boolean): ShortcutAction {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return { type: "none" };
  if (afterG) {
    const to = GO_KEYS[event.key.toLowerCase()];
    return to ? { type: "go", to } : { type: "none" };
  }
  if (event.key === "g") return { type: "wait-for-go" };
  if (event.key === "n") return { type: "new-task" };
  if (event.key === "?") return { type: "help" };
  return { type: "none" };
}
