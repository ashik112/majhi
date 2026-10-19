import { useSyncExternalStore } from "react";
import { z } from "zod";

/**
 * The owner's look: a theme, a mode (Light, Dark or System) and a density. Saved in this browser only.
 * index.html reads the same key before the first paint and sets the same three attributes on <html>,
 * so keep the two in step. The palettes themselves are tokens in styles.css, nothing here.
 */
export const THEME_IDS = ["graphite", "warm", "focus", "mission"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export const THEME_LABEL: Record<ThemeId, string> = {
  graphite: "Graphite",
  warm: "Warm",
  focus: "Focus",
  mission: "Mission",
};

export const MODES = ["light", "dark", "system"] as const;
export type Mode = (typeof MODES)[number];

export const MODE_LABEL: Record<Mode, string> = { light: "Light", dark: "Dark", system: "System" };

export const DENSITIES = ["compact", "comfortable", "spacious"] as const;
export type Density = (typeof DENSITIES)[number];

export const DENSITY_LABEL: Record<Density, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious",
};

const KEY = "majhi.look";
/** The key of the look before themes: `{ theme: dark | light | system, accent }`. Only its mode carries over. */
const LEGACY_KEY = "majhi.appearance";

const LookSchema = z.object({
  theme: z.enum(THEME_IDS).catch("graphite"),
  mode: z.enum(MODES).catch("system"),
  density: z.enum(DENSITIES).catch("comfortable"),
});
export type Look = z.infer<typeof LookSchema>;

const DEFAULT: Look = { theme: "graphite", mode: "system", density: "comfortable" };

function stored(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function read(): Look {
  const saved = stored(KEY);
  const parsed = LookSchema.safeParse(saved);
  if (parsed.success && saved !== undefined) return parsed.data;
  const legacy = LookSchema.shape.mode.safeParse((stored(LEGACY_KEY) as { theme?: unknown } | undefined)?.theme);
  return legacy.success ? { ...DEFAULT, mode: legacy.data } : DEFAULT;
}

const lightQuery = () => window.matchMedia("(prefers-color-scheme: light)");

/** The mode actually shown: System follows the operating system. */
export function resolvedMode(choice: Mode): "dark" | "light" {
  if (choice !== "system") return choice;
  return lightQuery().matches ? "light" : "dark";
}

/** The tab bar and the browser chrome take the theme's ground, read from its token. */
function syncThemeColor(): void {
  const base = getComputedStyle(document.documentElement).getPropertyValue("--c-base").trim();
  if (base !== "") document.querySelector('meta[name="theme-color"]')?.setAttribute("content", base);
}

function apply(look: Look): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", look.theme);
  root.setAttribute("data-mode", resolvedMode(look.mode));
  root.setAttribute("data-density", look.density);
  syncThemeColor();
}

let current: Look = typeof window === "undefined" ? DEFAULT : read();
const listeners = new Set<() => void>();

/** Called once at start: the stylesheet is loaded by then, so the ground's token can be read. */
export function startLook(): void {
  apply(current);
  lightQuery().addEventListener("change", () => {
    if (current.mode === "system") apply(current);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setLook(next: Partial<Look>): void {
  current = { ...current, ...next };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Storage can be blocked; the choice still holds until the page reloads.
  }
  apply(current);
  for (const listener of listeners) listener();
}

export function useLook(): Look {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT,
  );
}
