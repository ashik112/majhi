import type Database from "better-sqlite3";
import type { Recommendation } from "./build.ts";
import type { RecommendationStore } from "./service.ts";

/** The captain's recommendations, one per decision id (`decision_recommendations`). */
export class RecommendationRepo implements RecommendationStore {
  constructor(private readonly db: Database.Database) {}

  all(): Map<string, Recommendation> {
    const rows = this.db.prepare("SELECT id, option, reason FROM decision_recommendations").all() as {
      id: string;
      option: string;
      reason: string;
    }[];
    return new Map(rows.map((r) => [r.id, { option: r.option, reason: r.reason }]));
  }

  set(id: string, rec: Recommendation, at: string): void {
    this.db
      .prepare(
        "INSERT INTO decision_recommendations (id, option, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET option = excluded.option, reason = excluded.reason, at = excluded.at",
      )
      .run(id, rec.option, rec.reason, at);
  }

  prune(keep: ReadonlySet<string>, before: string): void {
    const stale = this.db.prepare("SELECT id FROM decision_recommendations WHERE at < ?").all(before) as {
      id: string;
    }[];
    const drop = this.db.prepare("DELETE FROM decision_recommendations WHERE id = ?");
    for (const { id } of stale) if (!keep.has(id)) drop.run(id);
  }
}
