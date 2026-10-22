import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { CONN, envelope } from "./testing/world.ts";

/**
 * Closing an incident is what tells a client and sends the report. A subtask's close never does it, and the report
 * goes once, with times that start at the incident's own open.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const minutesAgo = (n: number): string => new Date(Date.now() - n * 60_000).toISOString();

/** An Acme incident a client chat follows, with the captain's wakes and the chat app's sends recorded. */
async function incidentWithChat(clientUpdate: "ask" | "sends") {
  w = await bossWorld({ real: false });
  const { h } = w;
  const services = h.majhi.services;
  const parts = services.chatParts;
  await h.cmd("authority.set", { org: "acme", level: "routine", clientUpdate });
  const conn = { ...CONN, org: "acme" };
  await parts.ingest.deliver(conn, envelope({ chatId: "-700", message: "1", text: "Checkout is down" }));
  const found = parts.rooms.find("telegram", conn.account, "-700");
  if (found === undefined) throw new Error("no room");
  const room = await parts.rooms.link(found.id, "acme");
  const { task: id } = await services.incidentEngine.open({
    kind: "deploy",
    org: "acme",
    record: {
      id: 1,
      org: "acme",
      project: "acme-api",
      env: "production",
      commit: "f".repeat(40),
      state: "failed",
      by: "captain",
      runs: [],
      handles: [],
      seq: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never,
    title: "Deploy of acme-api to production failed",
    text: "The pipeline failed",
    tier: "production",
  });
  services.store.tasks.putLink({ task: id, type: "client", other: room.id });
  const wakes: string[] = [];
  vi.spyOn(services.lanes, "tell").mockImplementation(async (_org, text) => {
    wakes.push(text);
    return { sent: true, chat: "lane" };
  });
  const sends: string[] = [];
  vi.spyOn(parts.hub, "send").mockImplementation(async (_app, _account, _target, message) => {
    sends.push(JSON.stringify(message.body));
    return { message: String(900 + sends.length) };
  });
  const tick = async () => {
    await parts.incidents.tick();
    await parts.desk.flush(room.id);
  };
  const items = (type: RoomItem["type"], task: string): RoomItem[] => services.store.room.ofType(task, type);
  return { h, services, id, room, wakes, sends, tick, items };
}

describe("closing an incident", () => {
  it("is not done by its last subtask: the incident stays open, no client is told and no report is made", async () => {
    const t = await incidentWithChat("sends");
    // The chat has been told it is being looked into; that is the last news.
    await t.tick();
    t.wakes.length = 0;

    const made = await t.h.cmd("tasks.create", {
      text: "restart the worker",
      repos: [{ project: "acme-api" }],
      start: false,
    });
    expect(made.status).toBe(200);
    const sub = (made.body as { id: string }).id;
    await t.services.tasks.link({ task: sub, type: "parent", target: t.id });
    // A fix task under it moves the chat to Identified: that news goes out before the close.
    await t.tick();
    t.wakes.length = 0;
    expect((await t.h.cmd("tasks.close", { id: sub })).status).toBe(200);

    expect(t.services.store.tasks.get(sub)?.status).toBe("done");
    expect(t.services.store.tasks.get(t.id)?.status).not.toBe("done");
    await t.tick();
    await t.tick();
    expect(t.wakes).toEqual([]);
    expect(t.sends).toEqual([]);
    expect(t.items("report", t.id)).toEqual([]);
    expect(t.items("client-reply", t.room.id)).toEqual([]);
    const said = t.items("system", t.id).map((i) => (i.type === "system" ? i.text : ""));
    expect(said.filter((s) => s.startsWith(`Every subtask of ${t.id} is done.`))).toHaveLength(1);
  });

  it("sends one report, whatever the passes, and its time starts at the incident's own open", async () => {
    const t = await incidentWithChat("sends");
    const { store } = t.services;
    // The incident was opened two hours ago, from a watch incident that opened two weeks ago.
    store.raw.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(minutesAgo(120), t.id);
    const watch = store.raw
      .prepare(
        "INSERT INTO ops_incidents (org, key, title, severity, status, opened_at, resolved_at, flaps) VALUES ('acme', 'acme-api:checkout', 'Checkout check fails', 'high', 'resolved', ?, ?, 0)",
      )
      .run(minutesAgo(14 * 24 * 60), minutesAgo(100)).lastInsertRowid;
    store.raw
      .prepare("UPDATE tasks SET origin = ? WHERE id = ?")
      .run(JSON.stringify({ kind: "watch", watch: "wch-test1", incident: Number(watch) }), t.id);

    expect((await t.h.cmd("tasks.close", { id: t.id, unshipped: "keep" })).status).toBe(200);
    // Each pass finds the task's updated time a little different, as a done task's moves.
    for (const done of [60, 50, 40]) {
      store.raw.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(minutesAgo(done), t.id);
      await t.tick();
    }

    const reports = t.items("report", t.id);
    expect(reports).toHaveLength(1);
    const report = reports[0];
    if (report?.type !== "report") throw new Error("no report");
    // 75 minutes: from the incident's open (120 minutes ago) to when it resolved (45 minutes ago).
    expect(report.client.impact).toContain("It was failing for 75 min,");
    expect(t.sends).toHaveLength(1);
  });
});
