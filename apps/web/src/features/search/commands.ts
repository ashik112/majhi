/** One thing the palette can do besides search. */
export interface PaletteCommand {
  id: string;
  name: string;
  /** More words that find it: "create" for New task. */
  keywords: string;
  /** Said at the right edge of the row. */
  hint?: string | undefined;
  /** Only shown on a task's page. */
  task?: boolean;
  /** Why it cannot run now. The row stays, dimmed, so the owner sees it exists. */
  unavailable?: string | undefined;
  run: () => void;
}

/**
 * The commands that match what was typed: every typed word must start a word of the name or the
 * keywords. Names that start with the first typed word come first, then the list's own order.
 * Nothing typed lists them all. "Current task" commands are left out off a task page.
 */
export function matchCommands(
  commands: readonly PaletteCommand[],
  query: string,
  onTaskPage: boolean,
): PaletteCommand[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = commands.filter((c) => !c.task || onTaskPage);
  if (words.length === 0) return shown;
  const matched = shown.filter((c) => {
    const have = `${c.name} ${c.keywords}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return words.every((w) => have.some((h) => h.startsWith(w)));
  });
  const first = words[0] ?? "";
  const rank = (c: PaletteCommand) => (c.name.toLowerCase().startsWith(first) ? 0 : 1);
  return matched.toSorted((a, b) => rank(a) - rank(b));
}
