import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 117: summaries move to the day they cover, and nothing else in them changes. */
describe("the autonomy day caps migration", () => {
  it("moves each stored summary back one day, in the key and in the summary", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 117),
    );
    const add = db.prepare("INSERT INTO autonomy_summaries (day, at, summary) VALUES (?, ?, ?)");
    for (const day of ["2026-10-02", "2026-10-03"]) {
      add.run(day, `${day}T02:00:38.823Z`, JSON.stringify({ day, from: "f", to: "t", decisions: 3 }));
    }
    expect(migrate(db)).toContain(117);
    const rows = db.prepare("SELECT day, at, summary FROM autonomy_summaries ORDER BY day").all() as {
      day: string;
      at: string;
      summary: string;
    }[];
    expect(rows.map((r) => [r.day, r.at, JSON.parse(r.summary)])).toEqual([
      ["2026-10-01", "2026-10-02T02:00:38.823Z", { day: "2026-10-01", from: "f", to: "t", decisions: 3 }],
      ["2026-10-02", "2026-10-03T02:00:38.823Z", { day: "2026-10-02", from: "f", to: "t", decisions: 3 }],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM autonomy_day_caps").get()).toEqual({ n: 0 });
  });
});
