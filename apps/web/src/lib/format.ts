/** "1 repo", "3 repos". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "184 ms", "1.2 s", "14 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = ms / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
}

/** "just now", "5 min ago", "2 h ago", then a short date. */
export function formatAgo(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "at an unknown time";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "⌘" on Apple platforms, "Ctrl" elsewhere, for key hints. */
export const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Two letters for an org tile, from its task key ("GLX" gives "ID"). */
export function badgeLetters(key: string): string {
  return (
    key
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

/** "0 B", "812 B", "3.2 kB", "1.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const kb = bytes / 1000;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB`;
  const mb = kb / 1000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$0.00", "<$0.01", "$4.20", "$1,284.50". */
export function formatMoney(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  return USD.format(usd);
}

/** "950", "1.2k", "34k", "1.2M", "34M". One decimal below 10, whole numbers above. */
export function formatTokens(count: number): string {
  const n = Math.max(0, Math.round(count));
  if (n < 1000) return String(n);
  const scaled = (value: number, unit: string) => {
    const text = value < 9.95 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
    return `${text}${unit}`;
  };
  if (n < 999_500) return scaled(n / 1000, "k");
  if (n < 999_500_000) return scaled(n / 1_000_000, "M");
  return scaled(n / 1_000_000_000, "B");
}
