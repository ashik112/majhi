import type { BackupKind } from "@majhi/shared";

export interface Kept {
  name: string;
  kind: BackupKind;
  /** ISO time the backup was taken. */
  at: string;
  /** False once a check found it damaged. A backup nobody checked counts as good. */
  usable: boolean;
}

export interface Rules {
  daily: number;
  weekly: number;
  safety: number;
}

/** The Monday of the week a time falls in (UTC), `YYYY-MM-DD`: one weekly backup per such week. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

const newestFirst = (a: Kept, b: Kept) =>
  a.at === b.at ? b.name.localeCompare(a.name) : b.at.localeCompare(a.at);

/**
 * Which backups to delete. Keeps the newest `daily` daily ones, then the newest daily one of each
 * of the `weekly` weeks before them, and the newest `safety` of every other kind. A damaged backup
 * takes no slot and is deleted once a good one is kept. Whatever the rules say, the newest usable
 * backup is never on the list: deleting the last good copy is never worth the space.
 */
export function selectPrune(all: readonly Kept[], rules: Rules): string[] {
  const keep = new Set<string>();
  const good = all.filter((b) => b.usable).sort(newestFirst);

  const dailies = good.filter((b) => b.kind === "daily");
  for (const b of dailies.slice(0, rules.daily)) keep.add(b.name);
  const weeks = new Set<string>();
  for (const b of dailies.slice(rules.daily)) {
    if (weeks.size >= rules.weekly) break;
    const week = weekOf(b.at);
    if (weeks.has(week)) continue;
    weeks.add(week);
    keep.add(b.name);
  }
  for (const kind of ["manual", "before-update", "before-migration", "before-restore"] as const) {
    for (const b of good.filter((x) => x.kind === kind).slice(0, rules.safety)) keep.add(b.name);
  }

  // The newest good backup of any kind always survives, even when the rules above would not keep it.
  const newestGood = good[0];
  if (newestGood !== undefined) keep.add(newestGood.name);

  // Damaged copies are useless once a good one is kept; with no good one they are left alone.
  const prune = all.filter((b) => !keep.has(b.name) && (b.usable || good.length > 0));
  return prune.map((b) => b.name);
}
