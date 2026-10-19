import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "./index.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 191: names, the Now / Next / Done when lines and the idea mark are new, empty columns. */

const AT = "2026-10-05T10:00:00.000Z";
let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A database as it was before migration 191, with tasks of every shape in it, and a copy of it. */
function oldDatabaseCopy(): string {
  dir = mkdtempSync(join(tmpdir(), "majhi-lines-"));
  const original = join(dir, "original.db");
  const db = new Database(original);
  db.pragma("foreign_keys = ON");
  migrate(
    db,
    MIGRATIONS.filter((m) => m.id < 191),
  );
  const insert = db.prepare(
    "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at, start_when_ready, priority) VALUES (?, ?, ?, ?, ?, ?, '[\"dev\"]', ?, ?, ?, ?)",
  );
  insert.run(
    "ACM-1",
    "Fix the cart badge",
    "Fix the cart badge",
    "code",
    "running",
    "/t/ACM-1",
    AT,
    AT,
    0,
    null,
  );
  insert.run("ACM-2", "Write the tests", "Write the tests", "code", "inbox", "/t/ACM-2", AT, AT, 1, "high");
  insert.run("ACM-3", "Chat", "Chat", "chat", "running", "/t/ACM-3", AT, AT, 0, null);
  db.prepare(
    "INSERT INTO task_repos (task, project, source, base, branch, created_branch, pos) VALUES ('ACM-1', 'web', '/r/web', 'main', 'fix/cart-badge', 1, 0)",
  ).run();
  db.close();
  const copy = join(dir, "majhi.db");
  copyFileSync(original, copy);
  return copy;
}

describe("the task lines migration", () => {
  it("leaves every old task as it was, with no name, no lines and no idea mark", () => {
    const store = new Store(oldDatabaseCopy());
    try {
      const first = store.tasks.get("ACM-1");
      expect(first).toMatchObject({
        id: "ACM-1",
        title: "Fix the cart badge",
        status: "running",
        folder: "/t/ACM-1",
        repos: [{ project: "web", branch: "fix/cart-badge" }],
      });
      expect(first?.name).toBeUndefined();
      expect(first?.now).toBeUndefined();
      expect(first?.next).toBeUndefined();
      expect(first?.doneWhen).toBeUndefined();
      expect(first?.idea).toBeUndefined();
      expect(store.tasks.get("ACM-2")?.status).toBe("inbox");
      expect(
        store.tasks
          .list(true)
          .map((t) => t.id)
          .sort(),
      ).toEqual(["ACM-1", "ACM-2", "ACM-3"]);
    } finally {
      store.close();
    }
  });

  it("stores and reads the new columns, and clears them again", () => {
    const store = new Store(oldDatabaseCopy());
    try {
      store.tasks.setName("ACM-1", "Cart badge", AT);
      store.tasks.setStatusLines(
        "ACM-1",
        { now: "Reading the cart code", doneWhen: "Badge shows the count" },
        AT,
      );
      store.tasks.setStatusLines("ACM-1", { next: "Write the test" }, AT);
      const task = store.tasks.get("ACM-1");
      expect(task).toMatchObject({
        name: "Cart badge",
        now: "Reading the cart code",
        next: "Write the test",
        doneWhen: "Badge shows the count",
      });
      const row = store.tasks.list(true).find((t) => t.id === "ACM-1");
      expect(row).toMatchObject({ name: "Cart badge", now: "Reading the cart code" });
      store.tasks.setStatusLines("ACM-1", { now: null }, AT);
      expect(store.tasks.get("ACM-1")?.now).toBeUndefined();
      expect(store.tasks.get("ACM-1")?.next).toBe("Write the test");
    } finally {
      store.close();
    }
  });
});
