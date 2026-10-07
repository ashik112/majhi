import type { RoomItem, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type CoordinatorDeps, RoomCoordinator } from "./coordinator.ts";

/**
 * A plain-text question to the owner stops waiting once its agent ends a later turn without asking
 * again, whatever the task's status. A card left pending in review held the ship, and the lead could
 * neither see nor answer it.
 */

type Question = Extract<RoomItem, { type: "owner-question" }>;

function question(id: string, agent: string, state: Question["state"] = "pending"): Question {
  return {
    id,
    task: "ACM-1",
    seq: 1,
    at: "2026-01-01T00:00:00.000Z",
    type: "owner-question",
    agent,
    text: "Your call from earlier still stands.",
    choices: [],
    state,
  };
}

function world(status: Task["status"], cards: Question[]) {
  const items = new Map(cards.map((c) => [c.id, c]));
  const task = { id: "ACM-1", status, kind: "code", brief: "Fix the thing", team: ["acme-lead"] };
  const deps = {
    store: {
      tasks: { get: (id: string) => (id === task.id ? task : undefined) },
      room: {
        pendingOfType: (_task: string, type: string) =>
          [...items.values()].filter((i) => i.type === type && i.state === "pending"),
      },
    },
    room: {
      flush: () => undefined,
      post: (_task: string, id: string, item: Question) => items.set(id, { ...item, id }),
    },
  } as unknown as CoordinatorDeps;
  return { coordinator: new RoomCoordinator(deps), items };
}

describe("turn end clears the agent's own pending owner questions", () => {
  it.each(["review", "paused"] as const)("in %s, a turn that asks nothing new", async (status) => {
    const { coordinator, items } = world(status, [
      question("question:a", "acme-lead"),
      question("question:b", "acme-builder"),
    ]);
    await coordinator.turnEnded({ task: "ACM-1", agent: "acme-lead", text: "Rebased on main, tests pass." });
    expect(items.get("question:a")?.state).toBe("moved-on");
    // Another agent's question is not this turn's to clear.
    expect(items.get("question:b")?.state).toBe("pending");
  });

  it("keeps the card when the turn asks the owner again", async () => {
    const { coordinator, items } = world("review", [question("question:a", "acme-lead")]);
    await coordinator.turnEnded({
      task: "ACM-1",
      agent: "acme-lead",
      text: "Done.\n\n@owner should I also bump the version?",
    });
    expect(items.get("question:a")?.state).toBe("pending");
  });
});
