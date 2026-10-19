import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { CONN, envelope } from "./testing/world.ts";

/**
 * What the captain is handed to tell a client about an incident is built from typed facts only: never the task's
 * id, branch, commit or title. And a failed production deploy opens one urgent incident that the next failure joins.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("an incident update", () => {
  it("hands the captain no task id, branch, commit or title, and a second failed production deploy joins the incident", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const services = h.majhi.services;
    const parts = services.chatParts;
    await h.cmd("authority.set", { org: "acme", level: "routine" });
    const conn = { ...CONN, org: "acme" };
    await parts.ingest.deliver(
      conn,
      envelope({
        chatId: "-700",
        message: "1",
        text: "Checkout page is down for everyone, order 4411 fails",
      }),
    );
    const found = parts.rooms.find("telegram", conn.account, "-700");
    if (found === undefined) throw new Error("no room");
    const room = await parts.rooms.link(found.id, "acme");
    const item = services.store.room
      .page(room.id, 10)
      .items.find((i): i is Extract<RoomItem, { type: "client" }> => i.type === "client");
    if (item === undefined) throw new Error("no client message");

    const { task: id } = await parts.incidents.claim(room, item, undefined, "A watch is firing on checkout");
    // The title and branch the task would carry once the lead named the work.
    services.store.raw
      .prepare("UPDATE tasks SET title = ? WHERE id = ?")
      .run("Checkout times out on payment", id);
    services.store.raw
      .prepare("UPDATE task_repos SET branch = ? WHERE task = ?")
      .run("fix/checkout-timeout", id);
    const task = services.store.tasks.get(id);
    if (task === undefined) throw new Error("no incident task");
    const branch = task.repos[0]?.branch ?? "";
    expect(branch).toBe("fix/checkout-timeout");
    // The fix landed: a commit exists that a client must never read.
    services.store.raw
      .prepare("UPDATE task_repos SET landed_commit = ?, landed_into = 'main', landed_at = ? WHERE task = ?")
      .run("abc1234def5678abc1234def5678abc1234def56", new Date().toISOString(), id);

    const wakes: string[] = [];
    vi.spyOn(services.lanes, "tell").mockImplementation(async (_org, text) => {
      wakes.push(text);
      return { sent: true, chat: "lane" };
    });
    await parts.incidents.tick();
    await parts.desk.flush(room.id);
    expect(wakes).toHaveLength(1);
    const handed = wakes[0] ?? "";
    expect(handed).toContain("What broke:");
    for (const internal of [id, branch, "abc1234", task.title, "order 4411"]) {
      expect([internal, handed.includes(internal)]).toEqual([internal, false]);
    }

    // A failed production deploy of the same project opens an urgent incident; another one joins it.
    const record = (n: number) =>
      ({
        id: n,
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
      }) as never;
    const first = await services.incidentEngine.open({
      kind: "deploy",
      org: "acme",
      record: record(1),
      title: "Deploy of acme-api to production failed",
      text: "The pipeline failed",
      tier: "production",
    });
    const second = await services.incidentEngine.open({
      kind: "deploy",
      org: "acme",
      record: record(2),
      title: "Deploy of acme-api to production failed",
      text: "The pipeline failed again",
      tier: "production",
    });
    expect(second).toMatchObject({ task: first.task, joined: true });
    expect(services.store.tasks.get(first.task)).toMatchObject({ priority: "urgent" });
  });
});
