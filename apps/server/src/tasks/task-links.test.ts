import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const create = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("tasks.create", { text, start: false, ...extra });
const list = async () => (await w.h.cmd("tasks.list", { includeDone: true })).body;
const summary = async (id: string) => (await list()).find((t: { id: string }) => t.id === id);
const items = async (task: string) => (await w.h.cmd("room.items", { task })).body.items;
const texts = async (task: string) => (await items(task)).map((i: { text?: string }) => i.text);

describe("tasks.link and tasks.unlink", () => {
  it("links a task to a parent and a dependency, and shows both in the list", async () => {
    w = await taskWorld();
    await create("fix api");
    await create("fix api more");
    await create("fix api again");
    expect((await w.h.cmd("tasks.link", { task: "ACM-2", type: "parent", target: "ACM-1" })).status).toBe(
      200,
    );
    const linked = await w.h.cmd("tasks.link", { task: "ACM-3", type: "depends-on", target: "ACM-2" });
    expect(linked.body.links).toEqual([{ type: "depends-on", task: "ACM-2", when: "merged" }]);

    expect((await summary("ACM-1")).children).toEqual({ total: 1, done: 0 });
    expect((await summary("ACM-2")).links).toEqual([{ type: "parent", task: "ACM-1" }]);
    expect((await summary("ACM-2")).children).toBeUndefined();
    expect((await summary("ACM-3")).waitingOn).toEqual(["ACM-2"]);
    expect((await summary("ACM-1")).waitingOn).toEqual([]);

    const gone = await w.h.cmd("tasks.unlink", { task: "ACM-3", type: "depends-on", target: "ACM-2" });
    expect(gone.body.links).toEqual([]);
    expect((await summary("ACM-3")).waitingOn).toEqual([]);
    expect(
      (await w.h.cmd("tasks.unlink", { task: "ACM-3", type: "depends-on", target: "ACM-2" })).status,
    ).toBe(404);
  });

  it("refuses self links, a second parent, unknown tasks and cycles with the cycle named", async () => {
    w = await taskWorld();
    for (const t of ["one api", "two api", "three api"]) await create(t);
    const self = await w.h.cmd("tasks.link", { task: "ACM-1", type: "depends-on", target: "ACM-1" });
    expect(self.status).toBe(409);
    expect((await w.h.cmd("tasks.link", { task: "ACM-1", type: "parent", target: "ACM-9" })).status).toBe(
      404,
    );

    await w.h.cmd("tasks.link", { task: "ACM-2", type: "depends-on", target: "ACM-1" });
    await w.h.cmd("tasks.link", { task: "ACM-3", type: "depends-on", target: "ACM-2" });
    const loop = await w.h.cmd("tasks.link", { task: "ACM-1", type: "depends-on", target: "ACM-3" });
    expect(loop.status).toBe(409);
    expect(loop.body.error).toBe("That would make a loop of dependencies: ACM-1 -> ACM-3 -> ACM-2 -> ACM-1.");

    await w.h.cmd("tasks.link", { task: "ACM-2", type: "parent", target: "ACM-1" });
    const second = await w.h.cmd("tasks.link", { task: "ACM-2", type: "parent", target: "ACM-3" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("ACM-2 is already part of ACM-1. Remove that link first.");
    const parentLoop = await w.h.cmd("tasks.link", { task: "ACM-1", type: "parent", target: "ACM-2" });
    expect(parentLoop.status).toBe(409);
    expect(parentLoop.body.error).toContain("loop of parents: ACM-1 -> ACM-2 -> ACM-1");
  });

  it("writes Related tasks into TASK.md of both tasks and refreshes it on unlink", async () => {
    w = await taskWorld();
    await create("fix api");
    await create("fix api more");
    await w.h.cmd("tasks.link", { task: "ACM-2", type: "depends-on", target: "ACM-1", when: "ready" });
    await w.h.cmd("tasks.link", { task: "ACM-2", type: "parent", target: "ACM-1" });
    const child = await readFile(join(w.taskDir("ACM-2"), "TASK.md"), "utf8");
    expect(child).toContain("- Part of ACM-1: fix api");
    expect(child).toContain("- Builds on ACM-1: fix api. Waits until it is ready for review (now inbox).");
    expect(child).toContain("`task/acm-1-fix-api`");
    expect(await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8")).toContain(
      "- Child ACM-2: fix api more (inbox)",
    );
    await w.h.cmd("tasks.unlink", { task: "ACM-2", type: "parent", target: "ACM-1" });
    await w.h.cmd("tasks.unlink", { task: "ACM-2", type: "depends-on", target: "ACM-1" });
    expect(await readFile(join(w.taskDir("ACM-2"), "TASK.md"), "utf8")).not.toContain("Related tasks");
    expect(await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8")).not.toContain("Related tasks");
  });
});

describe("tasks.create with links", () => {
  it("validates targets, links at creation, and inherits the parent's org", async () => {
    w = await taskWorld();
    await create("fix api");
    expect((await create("more", { parent: "ACM-9" })).status).toBe(404);
    expect((await create("more", { dependsOn: ["ACM-9"] })).status).toBe(404);
    expect((await w.h.cmd("tasks.list", {})).body).toHaveLength(1);

    const res = await create("think about the schema", { parent: "ACM-1", dependsOn: ["ACM-1", "ACM-1"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: "ACM-2", org: "acme", kind: "chat" });
    expect(res.body.links).toHaveLength(2);
    expect(res.body.links).toContainEqual({ type: "parent", task: "ACM-1" });
    expect(res.body.links).toContainEqual({ type: "depends-on", task: "ACM-1", when: "merged" });
    expect(await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8")).toContain("- Child ACM-2");
  });
});

describe("waiting tasks", () => {
  it("answers 409 on start while waiting, keeps the task ready, and creates without starting", async () => {
    w = await taskWorld();
    await create("fix api", { start: false });
    const waiting = await create("fix api later", { start: true, dependsOn: ["ACM-1"] });
    expect(waiting.status).toBe(200);
    expect(waiting.body.status).toBe("ready");
    expect(w.h.runtime.sessions).toHaveLength(0);
    expect((await summary("ACM-2")).waitingOn).toEqual(["ACM-1"]);
    expect(await texts("ACM-2")).toEqual(["Waiting on ACM-1. It starts when they are done."]);

    const refused = await w.h.cmd("tasks.start", { id: "ACM-2" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("Waiting on ACM-1. It starts when they are done.");
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).toBe("ready");
  });

  it("starts by itself when the last dependency is done, and says why", async () => {
    w = await taskWorld();
    await create("fix api one");
    await create("fix api two");
    await create("fix api three", { start: true, dependsOn: ["ACM-1", "ACM-2"] });

    await w.h.cmd("tasks.close", { id: "ACM-1" });
    expect((await w.h.cmd("tasks.get", { id: "ACM-3" })).body.status).toBe("ready");
    expect((await summary("ACM-3")).waitingOn).toEqual(["ACM-2"]);

    await w.h.cmd("tasks.close", { id: "ACM-2" });
    await w.h.majhi.services.runs.idle();
    const started = (await w.h.cmd("tasks.get", { id: "ACM-3" })).body;
    expect(started.status).toBe("review");
    expect(started.repos[0].worktree).toBeDefined();
    expect(await texts("ACM-3")).toContain("Started: ACM-2 is done.");
    expect((await summary("ACM-3")).waitingOn).toEqual([]);
  });

  it("does not start a task that was never asked to start", async () => {
    w = await taskWorld();
    await create("fix api one");
    await create("fix api two", { dependsOn: ["ACM-1"] });
    await w.h.cmd("tasks.close", { id: "ACM-1" });
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).toBe("inbox");
  });

  it("starts on review for a ready dependency, when the run manager reports the change", async () => {
    w = await taskWorld();
    await create("fix api one");
    await create("fix api two");
    await w.h.cmd("tasks.link", { task: "ACM-1", type: "depends-on", target: "ACM-2", when: "ready" });
    await w.h.cmd("tasks.start", { id: "ACM-1" }).then((r) => expect(r.status).toBe(409));
    w.h.majhi.services.store.tasks.setStatus("ACM-2", "review", undefined, new Date().toISOString());
    await w.h.majhi.services.tasks.statusChanged("ACM-2");
    await w.h.majhi.services.runs.idle();
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("review");
    expect(await texts("ACM-1")).toContain("Started: ACM-2 is ready for review.");
  });

  it("starts a waiting task when its link is removed", async () => {
    w = await taskWorld();
    await create("fix api one");
    await create("fix api two", { start: true, dependsOn: ["ACM-1"] });
    await w.h.cmd("tasks.unlink", { task: "ACM-2", type: "depends-on", target: "ACM-1" });
    await w.h.majhi.services.runs.idle();
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).toBe("review");
  });

  it("pauses a waiting task with an error item when its dependency is removed", async () => {
    w = await taskWorld();
    await create("fix api one");
    await create("fix api two", { start: true, dependsOn: ["ACM-1"] });
    const removed = await w.h.cmd("tasks.remove", { id: "ACM-1" });
    expect(removed.status).toBe(200);
    const task = (await w.h.cmd("tasks.get", { id: "ACM-2" })).body;
    expect(task).toMatchObject({ status: "paused", pausedReason: "owner", links: [] });
    const error = (await items("ACM-2")).find((i: { level?: string }) => i.level === "error");
    expect(error.text).toBe(
      "ACM-1 was removed, and this task was waiting for it. Start it anyway, or link it to another task?",
    );
    expect((await summary("ACM-2")).waitingOn).toEqual([]);
    // It does not start by itself, but the owner can start it.
    expect((await w.h.cmd("tasks.start", { id: "ACM-2" })).status).toBe(200);
  });
});

describe("parents and children", () => {
  it("closes the parent when every child is done, and posts an item", async () => {
    w = await taskWorld();
    await create("plan the work on api");
    await create("part one", { parent: "ACM-1" });
    await create("part two", { parent: "ACM-1" });
    expect((await summary("ACM-1")).children).toEqual({ total: 2, done: 0 });

    await w.h.cmd("tasks.close", { id: "ACM-2" });
    expect((await summary("ACM-1")).children).toEqual({ total: 2, done: 1 });
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).not.toBe("done");

    await w.h.cmd("tasks.close", { id: "ACM-3" });
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("done");
    expect(await texts("ACM-1")).toContain("Every subtask is done. Task closed.");
    expect(await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8")).toContain(
      "- Child ACM-3: part two (done)",
    );
  });

  it("closes the parent when the last open child is removed or unlinked", async () => {
    w = await taskWorld();
    await create("plan api");
    await create("part one", { parent: "ACM-1" });
    await create("part two", { parent: "ACM-1" });
    await w.h.cmd("tasks.close", { id: "ACM-2" });
    await w.h.cmd("tasks.remove", { id: "ACM-3" });
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("done");
  });

  it("makes the children top-level when the parent is removed", async () => {
    w = await taskWorld();
    await create("plan api");
    await create("part one", { parent: "ACM-1" });
    await w.h.cmd("tasks.remove", { id: "ACM-1" });
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.links).toEqual([]);
    expect(await readFile(join(w.taskDir("ACM-2"), "TASK.md"), "utf8")).not.toContain("Related tasks");
  });
});
