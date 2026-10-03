import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

/** The captain's own run slot (SPEC 5.16): its chats never wait behind worker agents. */

let w: BossWorld;
afterEach(() => w?.cleanup());

/** Every session's turns stay open until the test releases them, keyed by the task folder. */
function gated(): { open: Map<string, (() => void)[]>; release: (task: string) => void } {
  const open = new Map<string, (() => void)[]>();
  w.h.runtime.onSession = (session, start) => {
    const task = start.cwd.split("/").pop() ?? "";
    session.script = (turn) =>
      new Promise((resolve) => {
        turn.emit({ type: "text", messageId: "m", text: "busy" });
        open.set(task, [...(open.get(task) ?? []), () => resolve("end_turn")]);
        void turn.untilCancelled().then(() => resolve("cancelled"));
      });
  };
  return {
    open,
    release(task) {
      const waiting = open.get(task) ?? [];
      open.set(task, []);
      for (const r of waiting) r();
    },
  };
}

const startsIn = (task: string) => w.h.runtime.starts.filter((s) => s.cwd.endsWith(`/${task}`)).length;
const live = (task: string, agent: string) => w.h.majhi.services.room.getLive(task, agent);

describe("the captain's own slot", () => {
  it("starts captain chat runs at once while workers wait, without taking or freeing a worker slot", async () => {
    w = await bossWorld({ real: false });
    expect((await w.h.cmd("settings.set", { limits: { agents_max: 1, per_account: 1 } })).status).toBe(200);
    const turns = gated();
    for (const text of ["one on api", "two on api"]) {
      expect(
        (await w.h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true })).status,
      ).toBe(200);
    }
    const [first, second] = w.h.majhi.services.store.tasks
      .list(false)
      .filter((t) => t.chat !== true)
      .map((t) => t.id)
      .sort();
    if (first === undefined || second === undefined) throw new Error("two worker tasks expected");
    await w.until(() => live(second, "acme-builder")?.status === "queued", "the worker queue");
    expect(startsIn(first)).toBe(1);

    // The owner's chat with the captain, and the captain's Acme lane: both start now, on the same account.
    expect((await w.h.cmd("room.send", { task: w.chat.id, text: "hello" })).status).toBe(200);
    const lane = await w.h.majhi.services.lanes.tell("acme", "Check the board.", "lane wake");
    if (!lane.sent) throw new Error(`lane not woken: ${lane.why}`);
    await w.until(() => (turns.open.get(w.chat.id)?.length ?? 0) === 1, "the captain chat turn");
    await w.until(() => (turns.open.get(lane.chat)?.length ?? 0) === 1, "the lane turn");
    expect(live(second, "acme-builder")).toMatchObject({ status: "queued", slot: 1 });
    expect(live(w.chat.id, "boss")?.slot).toBeUndefined();

    // More wakes of the busy lane queue up behind its turn: still one session for it.
    for (const text of ["Again.", "And again.", "Once more."])
      await w.h.majhi.services.lanes.tell("acme", text, "lane wake");
    await new Promise((r) => setTimeout(r, 50));
    expect(startsIn(lane.chat)).toBe(1);

    // The captain ends its turns and goes idle: no worker slot opens, so the worker still waits.
    turns.release(w.chat.id);
    turns.release(lane.chat);
    await w.until(() => (turns.open.get(lane.chat)?.length ?? 0) === 1, "the lane's next turn");
    turns.release(lane.chat);
    await w.h.majhi.services.runs.idle(w.chat.id);
    expect(live(second, "acme-builder")?.status).toBe("queued");
    expect(startsIn(second)).toBe(0);
    expect(startsIn(lane.chat)).toBe(1);

    // The worker frees its slot: the next worker starts.
    turns.release(first);
    await w.until(() => startsIn(second) === 1, "the second worker");
  });

  it("puts the captain in line like any agent when it works on an ordinary task", async () => {
    w = await bossWorld({ real: false });
    expect((await w.h.cmd("settings.set", { limits: { agents_max: 1 } })).status).toBe(200);
    const turns = gated();
    expect(
      (await w.h.cmd("tasks.create", { text: "one on api", repos: [{ project: "acme-api" }], start: true }))
        .status,
    ).toBe(200);
    const made = await w.h.cmd("tasks.create", {
      text: "two on api @boss",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(made.status).toBe(200);
    const id = (made.body as { id: string }).id;
    await w.until(() => live(id, "boss")?.status === "queued", "the captain in line");
    expect(startsIn(id)).toBe(0);
    expect(turns.open.size).toBe(1);
  });
});
