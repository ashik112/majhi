import type { OpsIncident, Task } from "@majhi/shared";
import { describe, expect, it, vi } from "vitest";
import { IncidentFacts } from "../incident/facts.ts";
import { incidentHandlers } from "./incident-handlers.ts";
import { ClientIncidents } from "./incidents.ts";
import { CONN, envelope, world } from "./testing/world.ts";
import { ClientTriage, type TriageDeps } from "./triage.ts";

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
      open: () => [],
    },
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
  return { w, incidents, rooms, task, watch, reopened };
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
    const first = await incidents.attach(room, "ACM-9", "i1");
    expect(first.reopened).toBe(true);
    expect(reopened).toEqual(["ACM-9"]);
    expect(w.store.tasks.get("ACM-9")?.status).toBe("inbox");
    expect((await incidents.view("ACM-9"))?.status).toBe("investigating");

    const second = await incidents.attach(room, "ACM-9", "i2");
    expect(second.reopened).toBe(false);
    expect(reopened).toEqual(["ACM-9"]);
  });
});

describe('"any update?" from a client', () => {
  async function ask(chat: string | undefined) {
    const t = await setup();
    const roomId = chat ?? (t.rooms[0] as string);
    // A chat of the workspace that no incident is linked to.
    const other = chat === undefined ? roomId : await t.w.linked(chat);
    await t.w.ingest.deliver(CONN, envelope({ chatId: chat ?? "-100", message: "40", text: "Any update?" }));
    const item = t.w.store.room
      .page(other, 10)
      .items.find((i) => i.type === "client" && i.external.message === "40");
    if (item?.type !== "client") throw new Error("no message");
    const model = vi.fn(async (_o: string, _k: string, _p: string, parse: (x: string) => never) => {
      const parsed = parse('{"action":"update","reason":"asks how it is going"}') as {
        ok: boolean;
        value?: unknown;
      };
      return parsed.value;
    });
    const wiki = vi.fn(async () => ({ answer: "Guess", found: true }));
    const deps = {
      store: t.w.store,
      room: t.w.room,
      model,
      findings: {
        report: async () => ({ finding: { id: 1 } }),
        dismiss: () => undefined,
        toTask: async () => ({}),
      },
      replies: t.w.replies,
      wiki,
      rest: async () => undefined,
      incidents: (org: string, room: string) => t.incidents.candidates(org, room),
      incident: t.incidents,
    } as unknown as TriageDeps;
    const out = await new ClientTriage(deps).run(t.w.rooms.room(other), item);
    return { t, out, wiki };
  }

  it("in a chat linked to an open incident is answered from its status, through the reply rails", async () => {
    const { t, out, wiki } = await ask(undefined);
    expect(out?.action).toBe("update");
    expect(t.w.sent.at(-1)?.text).toBe(
      "We are looking into the problem. We will tell you here when we know more.",
    );
    expect(wiki).not.toHaveBeenCalled();
    // Under Tell Ask me the same answer waits instead of going out.
    t.w.state.tell = "ask";
    const before = t.w.sent.length;
    await new ClientTriage({
      store: t.w.store,
      room: t.w.room,
      model: async (_o: string, _k: string, _p: string, parse: (x: string) => never) =>
        (parse('{"action":"update","reason":"asks"}') as { value?: never }).value,
      findings: { report: async () => ({ finding: { id: 2 } }), dismiss: () => undefined },
      replies: t.w.replies,
      wiki,
      rest: async () => undefined,
      incidents: () => [],
      incident: t.incidents,
    } as unknown as TriageDeps).run(
      t.w.rooms.room(t.rooms[0] as string),
      t.w.store.room.page(t.rooms[0] as string, 10).items.find((i) => i.type === "client") as never,
    );
    expect(t.w.sent).toHaveLength(before);
  });

  it("counts a done task still in its soak as open, and answers Resolved once the soak has passed", async () => {
    const t = await setup("done");
    const now = new Date();
    t.watch.incident = {
      id: 1,
      org: "acme",
      title: "Orders down",
      status: "resolved",
      openedAt: new Date(now.getTime() - 3_600_000).toISOString(),
      resolvedAt: now.toISOString(),
    } as OpsIncident;
    const soaking = await t.incidents.answer(t.rooms[0] as string);
    expect(soaking?.text).not.toContain("resolved");
    t.watch.incident = { ...t.watch.incident, resolvedAt: new Date(now.getTime() - 3_600_000).toISOString() };
    // Closed with nothing shipped: the soak runs from the close, so the close was an hour ago too.
    t.w.store.raw
      .prepare("UPDATE tasks SET updated_at = ? WHERE id = 'ACM-9'")
      .run(new Date(now.getTime() - 3_000_000).toISOString());
    const after = await t.incidents.answer(t.rooms[0] as string);
    expect(after?.text).toContain("resolved");
  });

  it("in a chat with no linked incident is told there is no open issue, under the Tell rules", async () => {
    const { t } = await ask("-300");
    expect(t.w.sent.map((m) => m.text)).toEqual([
      "No open issue on our side right now. What are you seeing?",
    ]);
    const room = t.w.rooms.find("telegram", CONN.account, "-300");
    const message = t.w.store.room.page(room?.id ?? "", 20).items.find((i) => i.type === "client");
    expect(message).toMatchObject({ outcome: { state: "replied" } });
  });
});
