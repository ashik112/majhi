import { CAPTAIN_LANE_BRIEF, CLIENT_CHAT_BRIEF, type Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "./index.ts";

function task(id: string, patch: Partial<Task>): Task {
  return {
    id,
    title: `Title ${id}`,
    brief: "brief",
    kind: "code",
    org: "acme",
    status: "running",
    folder: `/tasks/${id}`,
    repos: [],
    team: ["dev"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  } as Task;
}

describe("conversations list", () => {
  it("lists every kind newest first, keeps the workspace, and hides archived ones only by flag", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACME-1", {}));
    store.tasks.insert(task("CAP-1", { kind: "chat", brief: CAPTAIN_LANE_BRIEF, org: "globex" }));
    store.tasks.insert(task("CHAT-1", { kind: "chat", brief: "Chat", title: "Chat", org: undefined }));
    store.tasks.insert(task("CLI-1", { kind: "chat", brief: CLIENT_CHAT_BRIEF, org: "acme" }));
    const say = (id: string, text: string) =>
      store.room.upsert(id, `a-${id}-${text}`, { type: "agent", agent: "dev", text });
    say("ACME-1", "first");
    say("CHAT-1", "second");
    say("CAP-1", "third");
    say("CLI-1", "fourth");

    const list = store.conversations.list();
    expect(list.map((c) => [c.id, c.kind, c.org])).toEqual([
      ["CLI-1", "client", "acme"],
      ["CAP-1", "captain", "globex"],
      ["CHAT-1", "agent", undefined],
      ["ACME-1", "task", "acme"],
    ]);
    expect(list.find((c) => c.id === "CHAT-1")?.agent).toBe("dev");

    expect(store.conversations.archive("CHAT-1", true)).toBe(true);
    expect(store.conversations.list().find((c) => c.id === "CHAT-1")?.archived).toBe(true);
    expect(store.conversations.archive("CHAT-1", false)).toBe(true);
    expect(store.conversations.list().find((c) => c.id === "CHAT-1")?.archived).toBeUndefined();
    expect(store.conversations.archive("NOPE", true)).toBe(false);
  });
});
