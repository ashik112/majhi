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
});
