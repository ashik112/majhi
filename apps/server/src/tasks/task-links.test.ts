import { afterEach, describe, expect, it } from "vitest";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const create = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("tasks.create", { text, start: false, ...extra });
const list = async () => (await w.h.cmd("tasks.list", { includeDone: true })).body;
const summary = async (id: string) => (await list()).find((t: { id: string }) => t.id === id);

describe("waiting tasks", () => {
  it("answers 409 on start while waiting, keeps the task ready, and creates without starting", async () => {
    w = await taskWorld();
    await create("fix api", { start: false, repos: [{ project: "acme-api" }] });
    const waiting = await create("fix api later", {
      start: true,
      dependsOn: ["ACM-1"],
      repos: [{ project: "acme-api" }],
    });
    expect(waiting.status).toBe(200);
    expect(waiting.body.status).toBe("ready");
    expect(w.h.runtime.sessions).toHaveLength(0);
    expect((await summary("ACM-2")).waitingOn).toEqual(["ACM-1"]);

    const refused = await w.h.cmd("tasks.start", { id: "ACM-2" });
    expect(refused.status).toBe(409);
    expect((await w.h.cmd("tasks.get", { id: "ACM-2" })).body.status).toBe("ready");
  });
});

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
});
