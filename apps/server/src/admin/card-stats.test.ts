import type { Task, TaskId } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { cardStats } from "./card-stats.ts";

type State = "pending" | "applied" | "rejected" | "failed" | "undone";

function card(command: string, state: State, extra: { alone?: true; rule?: "task" | "org" } = {}) {
  return {
    type: "approval" as const,
    agent: "acme-builder",
    command,
    risk: "change" as const,
    summary: command,
    input: "{}",
    state,
    ...extra,
  };
}

function storeWithTask(): Store {
  const store = new Store(":memory:");
  store.tasks.insert({
    id: "ACM-1",
    title: "Fix the api",
    brief: "",
    kind: "code",
    org: "acme",
    status: "inbox",
    folder: "/tasks/ACM-1",
    repos: [],
    team: ["acme-builder"],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task);
  return store;
}

describe("approval card stats", () => {
  it("counts each command's cards by what came of them", () => {
    const store = storeWithTask();
    const task = "ACM-1" as TaskId;
    const cards = [
      card("tasks.create", "applied"),
      card("tasks.create", "applied"),
      card("tasks.create", "undone"),
      card("tasks.create", "applied", { alone: true }),
      card("tasks.create", "applied", { rule: "org" }),
      card("tasks.create", "rejected"),
      card("tasks.create", "failed"),
      card("tasks.create", "failed", { alone: true }),
      card("tasks.create", "pending"),
      card("tasks.close", "pending"),
    ];
    for (const [i, c] of cards.entries()) store.room.upsert(task, `approval:${i}`, c);
    store.room.upsert(task, "info:1", { type: "system", level: "info", text: "not a card" });

    const stats = cardStats(store.room, 14);
    expect(stats.commands).toEqual([
      { command: "tasks.create", shown: 9, approved: 3, ranAlone: 2, rejected: 1, failed: 2, waiting: 1 },
      { command: "tasks.close", shown: 1, approved: 0, ranAlone: 0, rejected: 0, failed: 0, waiting: 1 },
    ]);
  });

  it("leaves out cards older than the window", () => {
    const store = storeWithTask();
    store.room.upsert("ACM-1" as TaskId, "approval:1", card("tasks.create", "applied"));
    expect(cardStats(store.room, 14, Date.now() + 15 * 86_400_000).commands).toEqual([]);
    expect(cardStats(store.room, 14, Date.now() + 13 * 86_400_000).commands).toHaveLength(1);
  });
});
