import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "./migrations.ts";

describe("room items by type", () => {
  it("answers what waits for the owner from the index, not a scan of every item", () => {
    const db = new Database(":memory:");
    migrate(db);
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT DISTINCT "task" FROM "room_items"
         WHERE "room_items"."type" IN ('approval', 'secret') AND json_extract("room_items"."payload", '$.state') = 'pending'`,
      )
      .all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("room_items_type");
  });
});
