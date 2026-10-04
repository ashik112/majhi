import { PAGE_PATH, type PagePath } from "../../lib/pages";

export type GoTarget = PagePath;

/** One key press: `mod` is Cmd on a Mac and Ctrl elsewhere. */
export interface Press {
  key: string;
  mod?: boolean;
  shift?: boolean;
}

export type ShortcutGroup = "Anywhere" | "Go to" | "Task" | "Board" | "Decisions" | "Today" | "Message box";

/**
 * One row of the shortcut table. The table is the single source: the handlers match key presses
 * against it and the `?` list prints it. A row with no `press` is handled by the part of the
 * screen it belongs to (the board's arrow keys, Esc in a room) and is listed here so the list is whole.
 */
export interface ShortcutDef {
  id: string;
  /** Keys as printed, one cap each. `Mod` prints as Cmd or Ctrl. */
  keys: readonly string[];
  what: string;
  group: ShortcutGroup;
  press?: Press;
  /** Pressed right after `g`. */
  afterG?: boolean;
  /** Fires while typing in a field. Only the palette, the captain chat and send do. */
  typing?: boolean;
  /** Where the page that handles it is. Matching ignores this; the handler checks it. */
  scope?: "task";
  go?: GoTarget;
}

const go = (letter: string, to: GoTarget, what: string): ShortcutDef => ({
  id: `go-${letter}`,
  keys: ["g", letter],
  what,
  group: "Go to",
  press: { key: letter },
  afterG: true,
  go: to,
});

export const SHORTCUT_TABLE: readonly ShortcutDef[] = [
  {
    id: "palette",
    keys: ["Mod", "K"],
    what: "Search, and run any command",
    group: "Anywhere",
    press: { key: "k", mod: true },
    typing: true,
  },
  { id: "new-task", keys: ["n"], what: "New task", group: "Anywhere", press: { key: "n" } },
  {
    id: "boss",
    keys: ["Mod", "J"],
    what: "Open or close the captain chat",
    group: "Anywhere",
    press: { key: "j", mod: true, shift: false },
    typing: true,
  },
  { id: "help", keys: ["?"], what: "Show this list", group: "Anywhere", press: { key: "?" } },
  {
    id: "chord",
    keys: ["g"],
    what: "Then a letter below goes to a page",
    group: "Go to",
    press: { key: "g" },
  },
  go("y", PAGE_PATH.today, "Go to Today (brief, agenda, plan)"),
  go("b", PAGE_PATH.board, "Go to the board"),
  go("a", PAGE_PATH.agents, "Go to agents"),
  go("c", PAGE_PATH.chats, "Go to chats"),
  go("u", PAGE_PATH.accounts, "Go to accounts"),
  go("n", PAGE_PATH.connections, "Go to connections"),
  go("h", PAGE_PATH.usage, "Go to health and usage"),
  go("k", PAGE_PATH.skills, "Go to skills"),
  go("m", PAGE_PATH.memory, "Go to memory"),
  go("t", PAGE_PATH.automations, "Go to automations (timers)"),
  go("s", PAGE_PATH.setup, "Go to hub setup"),
  go("i", PAGE_PATH.business, "Go to the business (knowledge, people, deadlines)"),
  go("p", PAGE_PATH.projects, "Go to projects and links"),
  go("o", PAGE_PATH.orgs, "Go to workspaces"),
  go("l", PAGE_PATH.audit, "Go to the audit log"),
  go("d", PAGE_PATH.decisions, "Go to decisions"),
  go("j", PAGE_PATH.captain, "Go to the captain page"),
  go("w", PAGE_PATH.watch, "Go to watch (services and incidents)"),
  go("r", PAGE_PATH.playbooks, "Go to playbooks"),
  { id: "next-task", keys: ["]"], what: "Next task", group: "Task", press: { key: "]" }, scope: "task" },
  { id: "prev-task", keys: ["["], what: "Previous task", group: "Task", press: { key: "[" }, scope: "task" },
  {
    id: "approve",
    keys: ["a"],
    what: "Approve: the main button of the review card",
    group: "Task",
    press: { key: "a" },
    scope: "task",
  },
  { id: "stop", keys: ["Esc"], what: "Stop the agent in an open task", group: "Task" },
  {
    id: "send",
    keys: ["Mod", "Enter"],
    what: "Send (stops a working agent first)",
    group: "Message box",
    press: { key: "Enter", mod: true },
    typing: true,
  },
  { id: "queue", keys: ["Enter"], what: "Send, or queue for the next turn", group: "Message box" },
  { id: "newline", keys: ["Shift", "Enter"], what: "New line", group: "Message box" },
  { id: "board-move", keys: ["j", "k", "h", "l"], what: "Move between cards (arrows too)", group: "Board" },
  {
    id: "decisions-move",
    keys: ["j", "k"],
    what: "Next or previous decision (arrows too)",
    group: "Decisions",
  },
  { id: "decisions-main", keys: ["Enter"], what: "Take the main action", group: "Decisions" },
  {
    id: "decisions-pick",
    keys: ["1", "2", "3"],
    what: "Pick the answer with that number",
    group: "Decisions",
  },
  { id: "decisions-reply", keys: ["r"], what: "Write a reply", group: "Decisions" },
  { id: "decisions-open", keys: ["o"], what: "Open the task", group: "Decisions" },
  { id: "today-move", keys: ["j", "k"], what: "Next or previous item (arrows too)", group: "Today" },
  { id: "today-open", keys: ["Enter"], what: "Take the item's action", group: "Today" },
  { id: "today-done", keys: ["e"], what: "Dismiss a finding or close a date", group: "Today" },
  { id: "board-open", keys: ["Enter"], what: "Open the card you are on", group: "Board" },
];

/** The table row with this id. */
export function shortcut(id: string): ShortcutDef {
  const def = SHORTCUT_TABLE.find((s) => s.id === id);
  if (!def) throw new Error(`No shortcut ${id}`);
  return def;
}

/** `g` then one of these keys goes to a page. Read from the table. */
export const GO_KEYS: Record<string, GoTarget> = Object.fromEntries(
  SHORTCUT_TABLE.flatMap((s) => (s.go && s.press ? [[s.press.key, s.go] as const] : [])),
);

/** The keys that go to this page, as printed ("g y"), or undefined when none does. */
export function chordOf(path: GoTarget): string | undefined {
  const def = SHORTCUT_TABLE.find((s) => s.go === path);
  return def === undefined ? undefined : def.keys.join(" ");
}

/** How long after `g` the second key still counts. */
export const CHORD_MS = 1200;

export interface ShortcutKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing: boolean;
}

/** Whether the event is this press. Shift only counts when the press asks for it, except for keys that need it (`?`). */
export function pressMatches(press: Press, event: ShortcutKey): boolean {
  if (event.isComposing || event.altKey) return false;
  const mod = event.metaKey || event.ctrlKey;
  if (Boolean(press.mod) !== mod) return false;
  if (press.shift !== undefined && Boolean(press.shift) !== Boolean(event.shiftKey)) return false;
  // With Cmd or Ctrl held, the letter's case does not matter; without, `n` is not `N`.
  return press.mod ? event.key.toLowerCase() === press.key.toLowerCase() : event.key === press.key;
}

/** Cmd or Ctrl with Enter: the message box's send key, read from the table. */
export function isSendPress(event: ShortcutKey): boolean {
  const press = shortcut("send").press;
  return press !== undefined && pressMatches(press, { ...event, shiftKey: false });
}

/** `id` is a table id, `wait-for-go` after `g`, or `none`. `go` is set for the page shortcuts. */
export interface ShortcutAction {
  id: string;
  go?: GoTarget;
}

/**
 * What a key press does, given whether `g` was pressed a moment ago and whether the owner is
 * typing in a field. The caller has already skipped presses inside dialogs and menus.
 */
export function resolveShortcut(event: ShortcutKey, afterG: boolean, typing: boolean): ShortcutAction {
  for (const def of SHORTCUT_TABLE) {
    if (!def.press || Boolean(def.afterG) !== afterG) continue;
    if (typing && !def.typing) continue;
    if (!pressMatches(def.press, event)) continue;
    if (def.id === "chord") return { id: "wait-for-go" };
    return def.go ? { id: def.id, go: def.go } : { id: def.id };
  }
  return { id: "none" };
}
