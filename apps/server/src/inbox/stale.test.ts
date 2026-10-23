import type { RoomItem } from "@majhi/shared";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../store/migrations.ts";
import { RecommendationRepo } from "./recommendations.ts";
import { InboxService } from "./service.ts";
import { StaleCards } from "./stale.ts";

/**
 * A card waits for the owner only while what it is about still needs the owner. The captain's lane held an
 * approval to push the branch of a task that had been merged and closed days before: it stayed in Needs you for good.
 */
type Approval = Extract<RoomItem, { type: "approval" }>;

const push = (task: string, about: string, command = "tasks.push"): Approval => ({
  id: `ap-${about}`,
  task,
  seq: 1,
  at: "2026-10-19T09:00:00.000Z",
  type: "approval",
  agent: "acme-captain",
  command,
  risk: "change",
  summary: `Push the branch of ${about}`,
  input: JSON.stringify({ id: about }),
  state: "pending",
});

function world(statuses: Record<string, string>, items: RoomItem[]) {
  const posted: { task: string; id: string; payload: Record<string, unknown> }[] = [];
  const stale = new StaleCards({
    store: {
      room: { waitingDecisions: () => items.filter((i) => "state" in i && i.state === "pending") },
      tasks: {
        subjectInfo: (id: string) => (statuses[id] === undefined ? undefined : { status: statuses[id] }),
      },
    } as never,
    room: {
      post: (task: string, id: string, payload: Record<string, unknown>) => {
        posted.push({ task, id, payload });
        const at = items.findIndex((i) => i.id === id && i.task === task);
        const old = items[at];
        if (old !== undefined) items[at] = { ...old, ...payload } as RoomItem;
      },
    } as never,
  });
  const inbox = new InboxService({
    items: () => items.filter((i) => "state" in i && i.state === "pending"),
    subject: (task) =>
      ({
        id: task,
        title: "The captain's lane",
        chat: true,
        lane: true,
        repos: 0,
        status: "running",
      }) as never,
    budgets: async () => [],
    signedOut: async () => [],
    recommendations: new RecommendationRepo(db()),
    actions: {} as never,
    closeStale: () => stale.sweep(),
  });
  return { inbox, posted };
}

function db(): Database.Database {
  const d = new Database(":memory:");
  migrate(d);
  return d;
}

describe("a card that waits for nobody", () => {
  it("leaves Needs you when the task it is about is done or removed, and its item is closed with a line", async () => {
    const items: RoomItem[] = [
      push("ACM-LANE", "ACM-6"),
      push("ACM-LANE", "ACM-7"),
      push("ACM-LANE", "ACM-8", "tasks.reopen"),
      push("ACM-LANE", "ACM-9"),
    ];
    const { inbox, posted } = world(
      { "ACM-LANE": "running", "ACM-6": "done", "ACM-7": "review", "ACM-8": "done" },
      items,
    );
    const shown = (await inbox.list()).map((d) => d.id);
    expect(shown).toEqual(["room:ACM-LANE:ap-ACM-7", "room:ACM-LANE:ap-ACM-8"]);
    const closed = posted.filter((p) => p.payload.state !== undefined);
    expect(closed.map((p) => [p.id, p.payload.state, p.payload.result])).toEqual([
      ["ap-ACM-6", "rejected", "ACM-6 is done, so this has nothing left to decide."],
      ["ap-ACM-9", "rejected", "ACM-9 was removed, so this has nothing left to decide."],
    ]);
    expect(posted.filter((p) => p.payload.type === "system").map((p) => p.payload.text)).toEqual([
      "Closed a request that waited for nobody: ACM-6 is done, so this has nothing left to decide.",
      "Closed a request that waited for nobody: ACM-9 was removed, so this has nothing left to decide.",
    ]);
  });
});
