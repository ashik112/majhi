import type Database from "better-sqlite3";
import { z } from "zod";

/** The tasks the owner pinned: one JSON value in the settings table the ops watch already uses for such state. */
const KEY = "tasks.pinned";

const PinsSchema = z.array(z.string());

/** A pinned task keeps its folder: the worktree budget never removes it. */
export class PinsRepo {
  constructor(private readonly db: Database.Database) {}

  list(): Set<string> {
    const row = this.db.prepare("SELECT value FROM ops_settings WHERE key = ?").get(KEY) as
      | { value: string }
      | undefined;
    if (row === undefined) return new Set();
    try {
      const parsed = PinsSchema.safeParse(JSON.parse(row.value));
      return new Set(parsed.success ? parsed.data : []);
    } catch {
      return new Set();
    }
  }

  set(task: string, pinned: boolean): void {
    const pins = this.list();
    if (pinned) pins.add(task);
    else pins.delete(task);
    this.db
      .prepare(
        "INSERT INTO ops_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(KEY, JSON.stringify([...pins].sort()));
  }
}
