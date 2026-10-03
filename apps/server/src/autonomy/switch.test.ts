import type { CaptainStatus } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

/** A captain world with Acme set to Keeps things tidy and the memory chore ready to run. */
async function world() {
  w = await bossWorld({ real: false });
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { level: "runs" } } })).status).toBe(200);
  return { h, services: h.majhi.services };
}

describe("the Autonomous switch is On or Off", () => {
  it("while Off, the captain's upkeep starts no run; On, it does", async () => {
    const { services } = await world();
    expect(services.autonomy.mode()).toBe("off");
    expect(services.captain.stopped()).toBe(true);
    expect(await services.captain.runner.start("acme", "memory", "test")).toBeUndefined();
    expect(services.captain.runner.busy()).toBe(false);

    expect(await w?.h.cmd("autonomy.start")).toMatchObject({ status: 200 });
    expect(services.captain.stopped()).toBe(false);
    expect(await services.captain.runner.start("acme", "memory", "test")).toBeDefined();
  });

  it("while Off, the captain's tools in a lane refuse with one line: no plan, no note, no answer", async () => {
    const { h, services } = await world();
    await h.cmd("autonomy.start");
    const chat = await services.autonomy.laneChat("acme");
    await h.cmd("autonomy.stop", { how: "now" });
    const off = { isError: true, text: "Autonomous is off, so the captain acts only when you ask." };
    const call = (tool: string, args: Record<string, unknown>) =>
      services.admin.call({ task: chat ?? "", agent: "boss" }, tool, { reason: "test", ...args });
    expect(await call("majhi_autonomy_note", { text: "hello" })).toEqual(off);
    expect(await call("majhi_autonomy_answer", { task: "ACME-1", item: "ask:1", option: "a" })).toEqual(off);
    // And no start of work, with the same idea in its own words.
    const start = await call("majhi_tasks_create", {
      text: "x",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    expect(start.isError).toBe(true);
    expect(start.text).toContain("Autonomous is off, so the captain does not start or change work in Acme");
  });

  it("captain.stop turns Autonomous off and pauses its tasks; captain.resume turns it on and resumes them", async () => {
    const { h, services } = await world();
    await h.cmd("autonomy.start");
    const chat = await services.autonomy.laneChat("acme");
    const made = await services.admin.call({ task: chat ?? "", agent: "boss" }, "majhi_tasks_create", {
      reason: "test",
      text: "fix the api",
      repos: [{ project: "acme-api" }],
      start: true,
    });
    const id = (JSON.parse(made.text) as { id: string }).id;
    await w?.until(() => services.store.tasks.get(id)?.status === "running", "the task to run");

    const stopped = (await h.cmd("captain.stop")).body as CaptainStatus;
    expect(stopped).toMatchObject({ autonomy: "off", stopped: false });
    expect(services.store.tasks.get(id)).toMatchObject({ status: "paused", pausedBy: "autonomy-off" });
    // The captain is never stopped: it still has its lane.
    expect(services.captain.stopped()).toBe(true);
    expect((await h.cmd("autonomy.status")).body.stopped).toEqual([id]);

    const resumed = (await h.cmd("captain.resume")).body as CaptainStatus;
    expect(resumed.autonomy).toBe("on");
    await w?.until(() => services.store.tasks.get(id)?.status === "running", "the task to run again");
    expect(services.store.tasks.get(id)?.pausedBy).toBeUndefined();
  });

  it("reads a stored paused as On", async () => {
    const { h, services } = await world();
    await h.cmd("autonomy.start");
    services.store.raw.prepare("UPDATE autonomy_state SET mode = 'paused' WHERE id = 1").run();
    expect(services.autonomy.mode()).toBe("on");
    expect((await h.cmd("autonomy.status")).body.mode).toBe("on");
    // The old Pause command is Off with its tasks paused.
    expect((await h.cmd("autonomy.pause")).body.mode).toBe("off");
  });

  it("records who paused a task: the captain, or Autonomous turned off", async () => {
    const { h, services } = await world();
    const made = await h.cmd("tasks.create", {
      text: "fix the api",
      repos: [{ project: "acme-api" }],
      attachments: [],
      start: true,
    });
    const id = (made.body as { id: string }).id;
    await w?.until(() => services.store.tasks.get(id)?.status === "running", "the task to run");
    await services.tasks.stop(id, "owner", undefined, "boss");
    expect(services.store.tasks.get(id)).toMatchObject({ status: "paused", pausedBy: "captain" });
    const summary = (await h.cmd("tasks.list")).body as { id: string; pausedBy?: string }[];
    expect(summary.find((s) => s.id === id)?.pausedBy).toBe("captain");

    // By hand it carries no mark, and resuming clears it.
    await h.cmd("tasks.start", { id });
    await w?.until(() => services.store.tasks.get(id)?.status === "running", "the task to run again");
    expect(services.store.tasks.get(id)?.pausedBy).toBeUndefined();
    await h.cmd("tasks.stop", { id });
    expect(services.store.tasks.get(id)?.pausedBy).toBeUndefined();
  });
});
