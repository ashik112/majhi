import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

/**
 * A real captain turn, scripted through the fake agent, handles an incident the watch opened: it opens a
 * fix task proposal with the evidence, drafts a status update through the outbound gate, and cannot
 * reach another workspace. Page text that tries to give it orders changes nothing.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

describe("the owner's commands", () => {
  it("let an approved agent call change what is watched, never who is paged or the phone", async () => {
    const world = await bossWorld();
    w = world;
    const agent = { actor: { kind: "agent", id: "boss" }, reason: "x" } as never;
    expect((await world.h.cmd("ops.overview", {}, agent)).status).toBe(200);
    const saved = await world.h.cmd(
      "ops.serviceSave",
      { org: "acme", name: "A", url: "https://a.example/", impact: "low", tls: false, dns: false },
      agent,
    );
    expect(saved.status).toBe(200);
    expect(world.h.majhi.services.ops.repo.services().map((s) => s.def.name)).toEqual(["A"]);
    for (const [name, body] of [
      ["ops.settings", { escalateMin: 1 }],
      ["ops.phoneSetup", {}],
      ["ops.phoneSet", { enabled: true }],
      ["ops.phoneForget", {}],
    ] as const) {
      const res = await world.h.cmd(name, body, agent);
      expect(res.status, name).toBe(409);
    }
    expect(world.h.majhi.services.ops.watch.settings().escalateMin).not.toBe(1);
    expect(await world.h.majhi.services.ops.phone.status()).toMatchObject({ state: "off" });
  });
});
