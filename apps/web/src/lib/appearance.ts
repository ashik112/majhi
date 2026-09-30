import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * The owner's theme and accent. Saved in this browser only; index.html reads the same key before the
 * first paint, so keep the two in step.
 */
export const THEMES = ["dark", "light", "system"] as const;
export type ThemeChoice = (typeof THEMES)[number];

export const ACCENTS = ["amber", "blue", "violet", "lime", "steel"] as const;
export type Accent = (typeof ACCENTS)[number];

export const ACCENT_LABEL: Record<Accent, string> = {
  amber: "Amber",
  blue: "Blue",
  violet: "Violet",
  lime: "Lime",
  steel: "Steel",
};

const KEY = "majhi.appearance";

const AppearanceSchema = z.object({
  theme: z.enum(THEMES).catch("dark"),
  accent: z.enum(ACCENTS).catch("amber"),
});
export type Appearance = z.infer<typeof AppearanceSchema>;

const DEFAULT: Appearance = { theme: "dark", accent: "amber" };

function read(): Appearance {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const parsed = AppearanceSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const lightQuery = () => window.matchMedia("(prefers-color-scheme: light)");

/** The theme actually shown: System follows the operating system. */
export function resolvedTheme(choice: ThemeChoice): "dark" | "light" {
  if (choice !== "system") return choice;
  return lightQuery().matches ? "light" : "dark";
}

function apply(appearance: Appearance): void {
  const root = document.documentElement;
  const theme = resolvedTheme(appearance.theme);
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-accent", appearance.accent);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#e5eaf0" : "#060a11");
}

let current: Appearance = typeof window === "undefined" ? DEFAULT : read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // While System is picked, follow the operating system as it switches.
  const media = lightQuery();
  const onChange = () => {
    if (current.theme === "system") apply(current);
  };
  media.addEventListener("change", onChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onChange);
  };
}

export function setAppearance(next: Partial<Appearance>): void {
  current = { ...current, ...next };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage can be blocked; the choice still holds until the page reloads.
  }
  apply(current);
  for (const listener of listeners) listener();
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT,
  );
}
