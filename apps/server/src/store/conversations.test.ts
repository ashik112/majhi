import { CAPTAIN_LANE_BRIEF, CHAT_BRIEF } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Store } from "./index.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

type Db = Database.Database;

function task(db: Db, id: string, o: { kind?: string; brief?: string; status?: string; org?: string } = {}) {
  db.prepare(
    "INSERT INTO tasks (id, title, brief, kind, status, org, folder, team, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, '/t', '[]', 'x', 'x')",
  ).run(id, `Task ${id}`, o.brief ?? "b", o.kind ?? "code", o.status ?? "running", o.org ?? null);
}

/** Items appear in order: `at` is minute n of a fixed day. */
function say(db: Db, taskId: string, n: number, type: string, text = `line ${n}`) {
  const at = `2027-01-01T00:${String(n).padStart(2, "0")}:00.000Z`;
  db.prepare("INSERT INTO room_items (task, id, seq, type, payload, at) VALUES (?, ?, ?, ?, ?, ?)").run(
    taskId,
    `i${n}`,
    n,
    type,
    JSON.stringify({ text }),
    at,
  );
  return at;
}

describe("the chat dock's unread count", () => {
  it("counts agent messages after the mark, never the owner's, system or context lines", () => {
    const store = new Store(":memory:");
    const db = store.raw;
    task(db, "ACM-1");
    say(db, "ACM-1", 1, "owner");
    const first = say(db, "ACM-1", 2, "agent");
    say(db, "ACM-1", 3, "agent");
    say(db, "ACM-1", 4, "system");
    say(db, "ACM-1", 5, "context");
    say(db, "ACM-1", 6, "tool");
    say(db, "ACM-1", 7, "owner", "thanks");
    expect(store.conversations.list().map((c) => [c.id, c.unread, c.lastLine])).toEqual([
      ["ACM-1", 2, "You: thanks"],
    ]);
    store.conversations.markRead("ACM-1", first);
    expect(store.conversations.one("ACM-1")?.unread).toBe(1);
  });

  it("caps a mark at the newest agent message, and never moves it back", () => {
    const store = new Store(":memory:");
    const db = store.raw;
    task(db, "ACM-1");
    const a = say(db, "ACM-1", 1, "agent");
    const b = say(db, "ACM-1", 2, "agent");
    store.conversations.markRead("ACM-1", "2999-01-01T00:00:00.000Z");
    expect(store.conversations.one("ACM-1")?.unread).toBe(0);
    // An invented far-future mark must not hide the reply that comes next.
    say(db, "ACM-1", 3, "agent");
    expect(store.conversations.one("ACM-1")?.unread).toBe(1);
    store.conversations.markRead("ACM-1", a);
    expect(store.conversations.one("ACM-1")?.unread).toBe(1);
    store.conversations.markRead("ACM-1", b);
    expect(store.conversations.one("ACM-1")?.unread).toBe(1);
  });

  it("lists task rooms and captain threads, not the owner's chats, empty rooms or finished tasks", () => {
    const store = new Store(":memory:");
    const db = store.raw;
    task(db, "ACM-1", { org: "acme" });
    task(db, "lane-acme", { kind: "chat", brief: CAPTAIN_LANE_BRIEF, org: "acme" });
    task(db, "chat-1", { kind: "chat", brief: CHAT_BRIEF });
    task(db, "LOCAL-1", { kind: "chat", brief: "Draft the Northwind notes" });
    task(db, "ACM-2");
    task(db, "ACM-3", { status: "done" });
    task(db, "ACM-4", { status: "done" });
    say(db, "ACM-1", 1, "agent");
    say(db, "lane-acme", 2, "agent");
    say(db, "chat-1", 3, "agent");
    say(db, "LOCAL-1", 6, "agent");
    say(db, "ACM-3", 4, "agent");
    say(db, "ACM-4", 5, "agent");
    store.conversations.markRead("ACM-4", "2027-01-01T00:05:00.000Z");
    const list = store.conversations.list();
    expect(list.map((c) => [c.id, c.kind, c.org])).toEqual([
      ["LOCAL-1", "task", undefined],
      ["ACM-3", "task", undefined],
      ["lane-acme", "captain", "acme"],
      ["ACM-1", "task", "acme"],
    ]);
    // Not a conversation: no mark is kept for it.
    expect(store.conversations.markRead("chat-1", "2027-01-01T00:03:00.000Z")).toBe(false);
    expect(store.conversations.markRead("nope", "2027-01-01T00:03:00.000Z")).toBe(false);
  });
});

describe("the read marks migration", () => {
  it("starts every existing conversation fully read, and counts only what comes after", () => {
    const db = new Database(":memory:");
    migrate(
      db,
      MIGRATIONS.filter((m) => m.id < 158),
    );
    task(db, "ACM-1");
    say(db, "ACM-1", 1, "agent");
    say(db, "ACM-1", 2, "agent");
    say(db, "ACM-1", 3, "owner");
    migrate(db);
    expect(db.prepare("SELECT id, read_at FROM read_marks").all()).toEqual([
      { id: "ACM-1", read_at: "2027-01-01T00:02:00.000Z" },
    ]);
  });
});
