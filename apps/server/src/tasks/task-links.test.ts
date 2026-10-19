import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const create = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("tasks.create", { text, start: false, ...extra });

describe("parents and children", () => {
  it("never closes a parent with open subtasks, and reopens a done task", async () => {
    w = await taskWorld();
    await create("plan the work on api", { repos: [{ project: "acme-api" }] });
    await create("part one", { parent: "ACM-1" });
    const refused = await w.h.cmd("tasks.close", { id: "ACM-1" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("ACM-2");
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).not.toBe("done");

    await w.h.cmd("tasks.close", { id: "ACM-2" });
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("done");
    const reopened = await w.h.cmd("tasks.reopen", { id: "ACM-1" });
    expect(reopened.body.status).toBe("inbox");
  });

  it("closes a task that still has open follow-ups", async () => {
    w = await taskWorld();
    await create("fix the api outage", { repos: [{ project: "acme-api" }] });
    await create("tighten the alert on api", { followUpOf: "ACM-1", repos: [{ project: "acme-api" }] });
    const closed = await w.h.cmd("tasks.close", { id: "ACM-1" });
    expect(closed.status).toBe(200);
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("done");
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).not.toBe("done");
  });
});

describe("a task held on a link to a task that is gone", () => {
  it("is released when the task is removed, and by the start-up sweep for a link left dangling", async () => {
    w = await taskWorld();
    await create("fix the api outage", { repos: [{ project: "acme-api" }] });
    await create("tighten the alert on api", { repos: [{ project: "acme-api" }] });
    await w.h.cmd("tasks.link", { task: "ACM-2", type: "depends-on", target: "ACM-1" });
    const { tasks, store } = w.h.majhi.services;
    const held = await tasks.apply("ACM-2", {
      type: "dependencyChanged",
      change: "closed-unmerged",
      on: ["ACM-1"],
      at: new Date().toISOString(),
    });
    expect("applied" in held).toBe(true);
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).toBe("paused");

    // The blocker is removed: the hold has nothing left to wait for.
    const removed = await w.h.cmd("tasks.remove", { id: "ACM-1" });
    expect(removed.status).toBe(200);
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).not.toBe("paused");

    // A link to a task that never existed (an old row) is dropped, and the hold it caused is lifted.
    store.tasks.putLink({ task: "ACM-2", type: "depends-on", other: "GHOST-9", when: "merged" });
    await tasks.apply("ACM-2", {
      type: "dependencyChanged",
      change: "closed-unmerged",
      on: ["GHOST-9"],
      at: new Date().toISOString(),
    });
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).toBe("paused");
    await tasks.reconcileDependencyHolds();
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).not.toBe("paused");
    expect(store.tasks.allLinks().filter((l) => l.other === "GHOST-9")).toEqual([]);
  });
});
