export const STUDIO_TABS = [
  { id: "agents", label: "Agents" },
  { id: "accounts", label: "Accounts" },
] as const;

export type StudioTab = (typeof STUDIO_TABS)[number]["id"];

export function parseStudioTab(value: string): StudioTab | undefined {
  return STUDIO_TABS.find((t) => t.id === value)?.id;
}

/** True for the key combination that opens Studio: Ctrl or Cmd with a period. */
export function isStudioShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ".";
}

/** Reads a search parameter as a non-empty string, or undefined. */
export function searchString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
