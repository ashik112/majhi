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
