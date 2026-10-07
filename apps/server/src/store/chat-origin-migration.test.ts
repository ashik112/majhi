import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./migrations.ts";

/** Migration 184: a task an agent made from a chat now names that chat; nothing else changes. */

const AT = "2026-10-05T10:00:00.000Z";
let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the tasks made from chats migration", () => {
  it("links a task to the chat whose tasks.create card made it, and leaves other origins alone", () => {
    dir = mkdtempSync(join(tmpdir(), "majhi-chat-origin-"));
    const db = new Database(join(dir, "majhi.db"));
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 184),
    );
    const task = db.prepare(
      "INSERT INTO tasks (id, title, brief, kind, status, folder, team, created_at, updated_at, origin) VALUES (?, ?, ?, ?, 'running', '/t', '[]', ?, ?, ?)",
    );
    task.run("LOCAL-1", "Chat", "Chat", "chat", AT, AT, null);
    task.run("LOCAL-2", "Captain chat", "Captain chat", "chat", AT, AT, null);
    task.run(
      "ACM-1",
      "Fix api",
      "Fix api",
      "code",
      AT,
      AT,
      JSON.stringify({ kind: "captain", reason: "Created by @dev" }),
    );
    task.run("ACM-2", "By hand", "By hand", "code", AT, AT, JSON.stringify({ kind: "owner" }));
    task.run("ACM-3", "Unrelated", "Unrelated", "code", AT, AT, null);
    const card = db.prepare(
      "INSERT INTO room_items (task, id, seq, type, payload, at) VALUES (?, ?, ?, 'approval', ?, ?)",
    );
    const created = (id: string, state = "applied") =>
      JSON.stringify({
        type: "approval",
        command: "tasks.create",
        state,
        result: `Starting branch: main. {"id":"${id}","title":"x"}`,
      });
    card.run("LOCAL-1", "a1", 1, created("ACM-1"), AT);
    // The owner made ACM-2 by hand; a card in a chat never relabels it.
    card.run("LOCAL-1", "a2", 2, created("ACM-2"), AT);
    // A card that failed, or a payload that is not JSON, links nothing and breaks nothing.
    card.run("LOCAL-1", "a3", 3, created("ACM-3", "failed"), AT);
    card.run("LOCAL-1", "a4", 4, "not json", AT);
    // The captain's own chat is not an ordinary chat.
    card.run("LOCAL-2", "b1", 1, created("ACM-3"), AT);
    db.close();

    const again = new Database(join(dir, "majhi.db"));
    expect(migrate(again)).toContain(184);
    const origin = (id: string) =>
      JSON.parse(
        ((again.prepare("SELECT origin FROM tasks WHERE id = ?").get(id) as { origin: string | null })
          .origin ?? "null") as string,
      );
    expect(origin("ACM-1")).toEqual({ kind: "chat", room: "LOCAL-1" });
    expect(origin("ACM-2")).toEqual({ kind: "owner" });
    expect(origin("ACM-3")).toBeNull();
    expect(origin("LOCAL-1")).toBeNull();
    again.close();
  });
});
