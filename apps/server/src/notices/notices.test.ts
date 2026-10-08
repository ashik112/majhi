import type { OwnerDecision } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { buildFeed } from "./feed.ts";
import { noticesHandlers } from "./handlers.ts";
import { NoticesService } from "./service.ts";

function decision(id: string, org: string, at: string): OwnerDecision {
  return {
    id,
    kind: "paused",
    org,
    title: `Paused: ${id}`,
    options: [{ id: "resume", label: "Resume", primary: true }],
    at,
    link: { kind: "captain" },
  };
}

const empty = {
  clientLines: [],
  taskStatuses: [],
  bugs: [],
  incidents: [],
  deploys: [],
  update: undefined,
  marks: { seen: undefined, rows: new Set<string>() },
  since: "2026-01-01T00:00:00.000Z",
};

describe("the bell's feed is scoped to a workspace", () => {
  it("leaves out the rows of every other workspace", () => {
    const decisions = [
      decision("a", "acme", "2026-01-02T00:00:00.000Z"),
      decision("g", "globex", "2026-01-03T00:00:00.000Z"),
    ];
    const feed = buildFeed({ ...empty, decisions, org: "acme" });
    expect(feed.notices.map((n) => n.org)).toEqual(["acme"]);
    expect(buildFeed({ ...empty, decisions }).notices).toHaveLength(2);
  });
});

describe("notices.markRead", () => {
  const at = new Date("2026-02-01T12:00:00.000Z");
  function service() {
    const store = new Store(":memory:");
    const events: string[][] = [];
    const notices = new NoticesService({
      store,
      events: { emit: (topics) => void events.push([...topics]) },
      decisions: async () => [
        decision("old", "acme", "2026-02-01T08:00:00.000Z"),
        decision("new", "acme", "2026-02-01T11:00:00.000Z"),
      ],
      update: async () => undefined,
      now: () => at,
    });
    return { notices, events, store };
  }

  it("moves the mark forward only, and never past now", async () => {
    const { notices, store } = service();
    await notices.markRead({ upTo: "2026-02-01T09:00:00.000Z" });
    expect(store.notices.marks().seen).toBe("2026-02-01T09:00:00.000Z");
    await notices.markRead({ upTo: "2026-02-01T07:00:00.000Z" });
    expect(store.notices.marks().seen).toBe("2026-02-01T09:00:00.000Z");
    await notices.markRead({ upTo: "2030-01-01T00:00:00.000Z" });
    expect(store.notices.marks().seen).toBe(at.toISOString());
  });

  it("is the owner's: an agent can neither read the feed nor mark it", async () => {
    const { notices } = service();
    const handlers = noticesHandlers(notices);
    const agent = {
      command: "notices.markRead" as const,
      meta: { actor: { kind: "agent", id: "builder" } } as unknown as Parameters<
        typeof handlers["notices.markRead"]
      >[1]["meta"],
    };
    await expect(handlers["notices.markRead"]({ upTo: "2026-02-01T10:00:00.000Z" }, agent)).rejects.toThrow(
      "owner's",
    );
    await expect(handlers["notices.list"]({}, { ...agent, command: "notices.list" })).rejects.toThrow("owner's");
  });
});
