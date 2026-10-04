import { type Calibration, CalibrationSchema } from "@majhi/shared";
import type Database from "better-sqlite3";

/** One calibration per slot (`decision_calibration`). A new fit replaces the old one. */
export class CalibrationStore {
  private readonly cache = new Map<string, Calibration | null>();
  private revision = 0;

  constructor(private readonly db: Database.Database) {}

  get(slot: string): Calibration | undefined {
    const known = this.cache.get(slot);
    if (known !== undefined) return known ?? undefined;
    const row = this.db.prepare("SELECT calibration FROM decision_calibration WHERE slot = ?").get(slot) as
      | { calibration: string }
      | undefined;
    let parsed: Calibration | undefined;
    if (row !== undefined) {
      try {
        const result = CalibrationSchema.safeParse(JSON.parse(row.calibration));
        parsed = result.success ? result.data : undefined;
      } catch {
        parsed = undefined;
      }
    }
    this.cache.set(slot, parsed ?? null);
    return parsed;
  }

  save(calibration: Calibration): void {
    this.db
      .prepare(
        "INSERT INTO decision_calibration (slot, calibration) VALUES (?, ?) ON CONFLICT (slot) DO UPDATE SET calibration = excluded.calibration",
      )
      .run(calibration.slot, JSON.stringify(calibration));
    this.cache.set(calibration.slot, calibration);
    this.revision += 1;
  }

  /** Changes whenever any slot is refitted, so the answer cache never serves an answer gated by an older fit. */
  version(): string {
    return String(this.revision);
  }
}
