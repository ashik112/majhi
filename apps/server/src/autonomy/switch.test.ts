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
  expect((await h.cmd("authority.set", { org: "acme", level: "routine" })).status).toBe(200);
  return { h, services: h.majhi.services };
}

describe("the Autonomous switch is On or Off", () => {
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
      ["majhi_tasks_create", { name: "Test task", text: "x", repos: [{ project: "acme-api" }], start: true }],
    ] as const) {
      const out = await call(tool, args);
      expect(out.isError).toBe(true);
      expect(out.text).toContain("Stop everything is on");
    }
  });
});
