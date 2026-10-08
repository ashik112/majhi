import type { CaptainStatus } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
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
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  return { h, services: h.majhi.services };
}

describe("the Autonomous switch is On or Off", () => {
  it("reacting work runs with Auto-pilot off: the lane exists and answers, while the backlog is not picked", async () => {
    const { h, services } = await world();
    await h.cmd("autonomy.start");
    await h.cmd("autonomy.stop", { how: "now" });
    expect(await services.autonomy.laneChat("acme", "reacting")).toBeDefined();
    expect(await services.autonomy.laneChat("acme", "backlog")).toBeUndefined();
    const chat = await services.autonomy.laneChat("acme");
    const call = (tool: string, args: Record<string, unknown>) =>
      services.admin.call({ task: chat ?? "", agent: "boss" }, tool, { reason: "test", ...args });
    expect((await call("majhi_autonomy_note", { text: "hello" })).isError).toBe(false);
    const plan = await call("majhi_autonomy_plan", { items: [] });
    expect(plan.isError).toBe(true);
    expect(plan.text).toContain("Auto-pilot is off");
  });

  it("Stop everything halts captain work: no lane, no tools, no start, whatever Auto-pilot says", async () => {
    const { h, services } = await world();
    await h.cmd("autonomy.start");
    const chat = await services.autonomy.laneChat("acme");
    await h.cmd("captain.stop");
    expect(await services.autonomy.laneChat("acme", "reacting")).toBeUndefined();
    const call = (tool: string, args: Record<string, unknown>) =>
      services.admin.call({ task: chat ?? "", agent: "boss" }, tool, { reason: "test", ...args });
    for (const [tool, args] of [
      ["majhi_autonomy_note", { text: "hello" }],
      ["majhi_autonomy_answer", { task: "ACME-1", item: "ask:1", option: "a" }],
      ["majhi_tasks_create", { text: "x", repos: [{ project: "acme-api" }], start: true }],
    ] as const) {
      const out = await call(tool, args);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Stop everything is on");
    }
  });

  it("captain.stop pauses the tasks the captain runs and leaves Auto-pilot as it is; captain.resume resumes them", async () => {
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
    expect(stopped).toMatchObject({ autonomy: "on", stopped: true });
    expect(services.store.tasks.get(id)).toMatchObject({ status: "paused", pausedBy: "autonomy-off" });
    expect(services.captain.stopped()).toBe(true);

    const resumed = (await h.cmd("captain.resume")).body as CaptainStatus;
    expect(resumed).toMatchObject({ autonomy: "on", stopped: false });
    await w?.until(() => services.store.tasks.get(id)?.status === "running", "the task to run again");
    expect(services.store.tasks.get(id)?.pausedBy).toBeUndefined();
  });
});
