import type { OpsIncident, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { incidentHandlers } from "./incident-handlers.ts";
import { ClientIncidents } from "./incidents.ts";
import { CONN, envelope, world } from "./testing/world.ts";

/**
 * Tests of the incident flow: what each client room is told, and who may send the report to a client. Real rooms,
 * store, outbound gate and rails; only the watch is a stub.
 */

async function setup(status: Task["status"] = "inbox") {
  const w = world({ tell: "decide", holds: { firstContact: false } });
  const watch: { incident?: OpsIncident } = {};
  const incidents = new ClientIncidents({
    store: w.store,
    room: w.room,
    replies: w.replies,
    gate: w.gate,
    findings: {
      ofTask: () => [],
      adopt: () => ({}) as never,
      get: () => ({}) as never,
      dismiss: () => ({}) as never,
    },
    watch: {
      incident: () => watch.incident,
      incidentOfFinding: () => watch.incident,
      open: () => [],
    },
    settings: async () => ({ soakMin: 15, cadenceMin: 30 }),
    tz: async () => "UTC",
    create: async () => ({ id: "ACM-1" }),
    changed: () => undefined,
  });
  // Two client rooms, each with a message from a person.
  const rooms: string[] = [];
  for (const [chat, title] of [
    ["-100", "Northwind ops"],
    ["-200", "Initech ops"],
  ] as const) {
    await w.ingest.deliver(CONN, envelope({ chatId: chat, message: "1", chat: { title, kind: "group" } }));
    const found = w.rooms.find("telegram", CONN.account, chat);
    if (found === undefined) throw new Error("no room");
    await w.rooms.link(found.id, "acme");
    await w.ingest.deliver(CONN, envelope({ chatId: chat, message: "2", chat: { title, kind: "group" } }));
    rooms.push(found.id);
  }
  const at = new Date().toISOString();
  const task: Task = {
    id: "ACM-9",
    title: "Orders page down",
    brief: "",
    kind: "ops",
    typing: { type: "incident", by: "captain" },
    status,
    org: "acme",
    folder: "/tmp/majhi-incident",
    repos: [],
    team: [],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    updatedAt: at,
  };
  w.store.tasks.insert(task);
  for (const room of rooms) w.store.tasks.putLink({ task: task.id, type: "client", other: room });
  return { w, incidents, rooms, task, watch };
}

describe("updates to client rooms", () => {
  it("each room hears of one incident once per status change, and not again on the next pass", async () => {
    const { w, incidents } = await setup();
    await incidents.tick();
    await incidents.tick();
    // Two rooms, one update each: Investigating.
    expect(w.sent.map((s) => s.chat).toSorted()).toEqual(["-100", "-200"]);
    expect(w.sent.every((s) => s.text.startsWith("We are looking into"))).toBe(true);

    // The captain marks the cause: both rooms hear Identified, once.
    incidents.cause("ACM-9", "A report query held the database busy", "A slow query held things up");
    await incidents.tick();
    await incidents.tick();
    expect(w.sent).toHaveLength(4);
    expect(w.sent.slice(2).every((s) => s.text.startsWith("We found what is causing it"))).toBe(true);
    const view = await incidents.view("ACM-9");
    expect(view?.rooms.map((r) => r.sees)).toEqual(["identified", "identified"]);
  });

  it("a room the owner holds is not written to", async () => {
    const { w, incidents, rooms } = await setup();
    w.rooms.holder(rooms[0] as string, "you");
    await incidents.tick();
    expect(w.sent.map((s) => s.chat)).toEqual(["-200"]);
  });
});

describe("the report to a client", () => {
  const resolved = () => setup("done");

  it("is made once the incident is resolved, and only the owner's click sends it", async () => {
    const { w, incidents, rooms } = await resolved();
    await incidents.tick();
    const view = await incidents.view("ACM-9");
    expect(view?.status).toBe("resolved");
    expect(view?.report?.client.summary).not.toBe("");
    const sentBefore = w.sent.length;

    // An agent, even the captain, cannot send or edit it.
    const handlers = incidentHandlers({ incidents, lane: async () => undefined, orgOf: () => "acme" });
    const agent = {
      command: "incident.sendReport",
      meta: { actor: { kind: "agent", id: "captain" } },
    } as never;
    await expect(
      handlers["incident.sendReport"]({ task: "ACM-9", room: rooms[0] as string }, agent),
    ).rejects.toThrow(/owner/);
    await expect(
      handlers["incident.editReport"]({ task: "ACM-9", version: "client", text: { summary: "x" } }, agent),
    ).rejects.toThrow(/owner/);
    expect(w.sent).toHaveLength(sentBefore);

    // The owner's click sends it to one room.
    const owner = { command: "incident.sendReport", meta: { actor: { kind: "owner" } } } as never;
    const out = await handlers["incident.sendReport"]({ task: "ACM-9", room: rooms[0] as string }, owner);
    expect(out.state).toBe("sent");
    expect(w.sent.at(-1)?.chat).toBe("-100");
    expect(w.sent.at(-1)?.text).toContain("Summary");
  });

  it("is frozen once sent: no edit, and no second send to the same room", async () => {
    const { w, incidents, rooms } = await resolved();
    await incidents.tick();
    incidents.editReport("ACM-9", "client", { summary: "Edited before it went." });
    await incidents.sendReport("ACM-9", rooms[0] as string);
    expect(w.sent.at(-1)?.text).toContain("Edited before it went.");
    expect(() => incidents.editReport("ACM-9", "client", { summary: "Changed after." })).toThrow(/frozen/);
    expect(() => incidents.editReport("ACM-9", "internal", { summary: "Changed after." })).toThrow(/frozen/);
    await expect(incidents.sendReport("ACM-9", rooms[0] as string)).rejects.toThrow(/already/);
    const count = w.sent.length;
    // The other room can still get it, with the same text.
    await incidents.sendReport("ACM-9", rooms[1] as string);
    expect(w.sent).toHaveLength(count + 1);
    expect(w.sent.at(-1)?.text).toContain("Edited before it went.");
  });

  it("is refused when the client version names another workspace or holds a secret", async () => {
    const { w, incidents, rooms } = await resolved();
    await incidents.tick();
    const before = w.sent.length;
    incidents.editReport("ACM-9", "client", { cause: "The same fault hit Globex last week." });
    await expect(incidents.sendReport("ACM-9", rooms[0] as string)).rejects.toThrow(/another client/);
    incidents.editReport("ACM-9", "client", {
      cause: "Password is hunter2 and token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await expect(incidents.sendReport("ACM-9", rooms[0] as string)).rejects.toThrow(/secret/);
    expect(w.sent).toHaveLength(before);
  });
});
