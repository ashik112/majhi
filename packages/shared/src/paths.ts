/** Expands a leading `~` against `home`. Leaves absolute paths alone. */
export function expandHome(path: string, home: string): string {
  const trimmed = path.trim();
  if (trimmed === "~") return stripTrailingSlash(home);
  if (trimmed.startsWith("~/")) return stripTrailingSlash(`${stripTrailingSlash(home)}/${trimmed.slice(2)}`);
  return stripTrailingSlash(trimmed);
}

/** Replaces a leading `home` with `~` for display. */
export function collapseHome(path: string, home: string): string {
  const base = stripTrailingSlash(home);
  if (path === base) return "~";
  if (path.startsWith(`${base}/`)) return `~${path.slice(base.length)}`;
  return path;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p;
}

/** Folders that hold the operating system, never project folders. */
const SYSTEM_ROOTS = [
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/proc",
  "/sbin",
  "/sys",
  "/usr",
  "/var",
  "/System",
  "/Library",
  "/Applications",
  "/private",
];

/**
 * Whether an absolute path is `/`, the folder of every user, or a system folder. These are refused as
 * project folders. `/var/folders` and `/private/tmp` style temporary folders are not blocked here.
 */
export function isSystemFolder(path: string): boolean {
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/" || clean === "/Users" || clean === "/home") return true;
  if (
    clean.startsWith("/private/tmp") ||
    clean.startsWith("/private/var/folders") ||
    clean.startsWith("/var/folders")
  ) {
    return false;
  }
  return SYSTEM_ROOTS.some((root) => clean === root || clean.startsWith(`${root}/`));
}

export type ProtectedFolder = "Documents" | "Desktop" | "Downloads" | "iCloud Drive";

/**
 * The macOS-protected folder `path` is in, or is, when there is one. macOS asks the owner once
 * whether Docker may read these, and without a yes the container sees an empty folder.
 * `path` may start with `~`. Matching is case-insensitive, as the default macOS volume is.
 */
export function protectedFolder(path: string, home: string): ProtectedFolder | undefined {
  const full = expandHome(path, home).toLowerCase();
  const base = stripTrailingSlash(home).toLowerCase();
  const table: readonly [string, ProtectedFolder][] = [
    ["documents", "Documents"],
    ["desktop", "Desktop"],
    ["downloads", "Downloads"],
    ["library/mobile documents", "iCloud Drive"],
  ];
  for (const [folder, name] of table) {
    const root = `${base}/${folder}`;
    if (full === root || full.startsWith(`${root}/`)) return name;
  }
  return undefined;
}
