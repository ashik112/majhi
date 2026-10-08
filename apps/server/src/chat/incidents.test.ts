import type { OpsIncident, Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { IncidentFacts } from "../incident/facts.ts";
import { incidentHandlers } from "./incident-handlers.ts";
import { ClientIncidents } from "./incidents.ts";
import { CONN, envelope, world } from "./testing/world.ts";

/**
 * Tests of the incident flow: what each client room is told, and who may send the report to a client. Real rooms,
 * store, outbound gate and rails; only the watch is a stub.
 */

async function setup(
  status: Task["status"] = "inbox",
  write?: (org: string, key: string, prompt: string) => Promise<string | undefined>,
) {
  const w = world({ tell: "decide", holds: { firstContact: false } });
  const watch: { incident?: OpsIncident } = {};
  const reopened: string[] = [];
  /** What the captain was woken with: one entry per room and status, as the desk delivers it. */
  const woken: { room: string; key: string; facts: string }[] = [];
  const desk = {
    event: (room: { id: string }, key: string, facts: string, onWoken?: () => void) => {
      woken.push({ room: room.id, key, facts });
      onWoken?.();
    },
  };
  const findings = {
    ofTask: () => (watch.incident === undefined ? [] : [{ id: 1 } as never]),
    adopt: () => ({}) as never,
    get: () => ({}) as never,
    dismiss: () => ({}) as never,
  };
  const facts = new IncidentFacts({
    store: w.store,
    findings,
    watch: { incident: () => watch.incident, incidentOfFinding: () => watch.incident },
    settings: async () => ({ soakMin: 15, cadenceMin: 30 }),
    envs: async () => 0,
  });
  const incidents = new ClientIncidents({
    store: w.store,
    room: w.room,
    replies: w.replies,
    gate: w.gate,
    findings,
    watch: {
      incident: () => watch.incident,
      incidentOfFinding: () => watch.incident,
    },
    desk,
    tz: async () => "UTC",
    facts,
    ...(write === undefined ? {} : { write }),
    engine: {
      open: async () => ({ task: "ACM-1", joined: false, started: false, projectUnknown: false }),
      evidence: () => [],
    },
    reopen: async (id) => {
      reopened.push(id);
      // What the lifecycle's reopen does to the row: a done task is open again.
      w.store.raw.prepare("UPDATE tasks SET status = 'inbox' WHERE id = ?").run(id);
    },
    askLead: async () => undefined,
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
  return { w, incidents, rooms, task, watch, reopened, woken };
}

describe("updates to client rooms", () => {
  it("wakes the captain once per room per status change, and not again on the next pass", async () => {
    const { incidents, rooms, woken } = await setup();
    await incidents.tick();
    await incidents.tick();
    // Two rooms, one wake each: Investigating.
    expect(woken.map((e) => e.room).toSorted()).toEqual([...rooms].toSorted());
    expect(woken.every((e) => e.facts.includes("Status now: we are looking into it"))).toBe(true);

    // The captain marks the cause: both rooms are woken for Identified, once, with the client wording of the cause.
    incidents.cause("ACM-9", "A report query held the database busy", "A slow query held things up");
    await incidents.tick();
    await incidents.tick();
    expect(woken).toHaveLength(4);
    expect(woken.slice(2).every((e) => e.facts.includes("A slow query held things up"))).toBe(true);
    expect(woken.slice(2).some((e) => e.facts.includes("report query held the database"))).toBe(false);
  });

  it("counts a room as told when the captain's reply goes out, not when it is woken", async () => {
    const { w, incidents, rooms } = await setup();
    await incidents.tick();
    expect((await incidents.view("ACM-9"))?.rooms.map((r) => r.sees)).toEqual([undefined, undefined]);
    const room = rooms[0] as string;
    const out = await w.replies.captain({ room, text: "We are on it.", flags: w.flags(), to: "u1" });
    incidents.replied(room, out.draft);
    expect((await incidents.view("ACM-9"))?.rooms.map((r) => r.sees)).toEqual(["investigating", undefined]);
  });

  it("a room the owner holds is not woken", async () => {
    const { w, incidents, rooms, woken } = await setup();
    w.rooms.holder(rooms[0] as string, "you");
    await incidents.tick();
    expect(woken.map((e) => e.room)).toEqual([rooms[1]]);
  });
});

describe("the report never claims what was not recorded", () => {
  it("says no fix was shipped and the cause is being confirmed, whatever the model wrote", async () => {
    const section = {
      summary: "We found and fixed it",
      impact: "Brief",
      cause: "A bad index",
      fix: "We deployed a fix",
      followUps: "None",
    };
    const { incidents } = await setup("done", async () =>
      JSON.stringify({ internal: section, client: section }),
    );
    await incidents.tick();
    const view = await incidents.view("ACM-9");
    expect(view?.report?.client.fix).not.toContain("deployed a fix");
    expect(view?.report?.client.fix).toContain("without a change from us");
    expect(view?.report?.client.cause).toBe("The cause is being confirmed.");
    expect(view?.report?.internal.fix).toBe("No fix was shipped. The problem recovered on its own.");
    expect(view?.report?.internal.cause).toBe("Not recorded.");
    // The owner is warned before sending it.
    expect(view?.report?.warn).toContain("No cause is recorded");
  });

  it("uses the model's words for a cause and fix that are recorded", async () => {
    const section = {
      summary: "Fixed",
      impact: "Brief",
      cause: "Slow query",
      fix: "Added an index",
      followUps: "None",
    };
    const { incidents, w } = await setup("done", async () =>
      JSON.stringify({ internal: section, client: section }),
    );
    incidents.cause("ACM-9", "report query", "a slow query");
    // A fix is recorded once something shipped: a deploy that is live.
    w.store.raw
      .prepare(
        `INSERT INTO deploys (org, project, env, commit_sha, state, task, by, runs, seq, attempt, created_at, updated_at, finished_at)
         VALUES ('acme', 'storefront', 'production', 'abcdef1234567', 'live', 'ACM-9', 'owner', '[]', 0, 1, ?, ?, ?)`,
      )
      .run(...Array(3).fill(new Date().toISOString()));
    await incidents.tick();
    const view = await incidents.view("ACM-9");
    expect(view?.report?.client.fix).toBe("Added an index");
    expect(view?.report?.client.cause).toBe("Slow query");
    expect(view?.report?.warn).toBeUndefined();
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
    const handlers = incidentHandlers({
      incidents,
      lane: async () => undefined,
      orgOf: () => "acme",
      askCaptain: async () => undefined,
    });
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

describe("a client says it is still broken after Resolved", () => {
  it("moves the done task back through the lifecycle once, and a second report does not reopen it again", async () => {
    const { w, incidents, rooms, reopened } = await setup("done");
    await incidents.tick();
    expect((await incidents.view("ACM-9"))?.status).toBe("resolved");

    const room = w.rooms.room(rooms[0] as string);
    const first = await incidents.attach(room, "ACM-9");
    expect(first.reopened).toBe(true);
    expect(reopened).toEqual(["ACM-9"]);
    expect(w.store.tasks.get("ACM-9")?.status).toBe("inbox");
    expect((await incidents.view("ACM-9"))?.status).toBe("investigating");

    const second = await incidents.attach(room, "ACM-9");
    expect(second.reopened).toBe(false);
    expect(reopened).toEqual(["ACM-9"]);
  });
});

describe("what each client room reads", () => {
  it("the report to one room never holds another room's events", async () => {
    const { w, incidents, rooms } = await setup("done");
    await incidents.tick();
    // Only the first room says it is back, after it was told Resolved.
    await incidents.attach(w.rooms.room(rooms[0] as string), "ACM-9");
    const [first, second] = rooms as [string, string];
    const sent = async (room: string): Promise<string> => {
      const before = w.sent.length;
      await incidents.sendReport("ACM-9", room);
      return w.sent
        .slice(before)
        .map((m) => m.text)
        .join("\n");
    };
    expect(await sent(second)).not.toContain("you told us it was back");
    expect(await sent(first)).toContain("you told us it was back");
  });
});
