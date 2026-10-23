import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await w?.cleanup();
  w = undefined;
});

describe("what an update that waits for idle waits for", () => {
  it("counts an agent in a turn, never a task that only says it is running, and settles that task", async () => {
    w = await taskWorld();
    const { h } = w;
    const { services } = h.majhi;

    // ACM-1 has an agent in a turn that stays open.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.runtime.onSession = (session) => {
      session.script = async () => {
        await held;
        return "end_turn";
      };
    };
    const make = (start: boolean) =>
      h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start });
    expect((await make(true)).status).toBe(200);
    await until(() => services.workInFlight() === 1, "the agent to be in its turn");

    // ACM-2 says it is running, and has no run and no agent: it is not work.
    expect((await make(false)).status).toBe(200);
    services.store.raw.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run("ACM-2");
    expect(services.store.tasks.get("ACM-2")?.status).toBe("running");
    expect(services.workInFlight()).toBe(1);

    // It stays untouched while it is new, and is settled once it has had nothing behind it for a while.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    services.workInFlight();
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    services.workInFlight();
    vi.useRealTimers();
    await until(() => services.store.tasks.get("ACM-2")?.status === "paused", "the stale task to be settled");
    const page = await h.cmd("room.items", { task: "ACM-2", limit: 100 });
    const lines = (page.body.items as RoomItem[]).flatMap((i) => (i.type === "system" ? [i.text] : []));
    expect(lines.filter((t) => t.startsWith("Nothing was working on this"))).toHaveLength(1);

    // The task with a live agent was left alone, and counts until its turn ends.
    expect(services.store.tasks.get("ACM-1")?.status).toBe("running");
    expect(services.workInFlight()).toBe(1);
    release();
    await until(() => services.workInFlight() === 0, "the turn to end");
  });
});
