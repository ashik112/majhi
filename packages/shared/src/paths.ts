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
