import type { DeployRunStep } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { C1, C2, C3, environment, GH, GL_PIPELINE, push, type Rig, rig } from "./testing/rig.ts";

describe("deploy", () => {
  let r: Rig;
  afterEach(async () => {
    await r.service.idle();
    await r.hosts.close();
    r.store.close();
  });

  describe("a plan of two environments", () => {
    beforeEach(async () => {
      r = await rig([environment("staging"), environment("production")]);
      push(r, C1);
    });

    const planBoth = () =>
      r.service.plan(
        {
          task: "ACM-1",
          steps: [
            { project: "storefront", env: "staging", runs: GH },
            { project: "storefront", env: "production", runs: GH },
          ],
        },
        "captain",
      );

    it("keeps the head out of a planned step until it runs, and does not deploy production before staging is live", async () => {
      const { records } = await planBoth();
      const [staging, production] = records;
      expect(records.map((x) => [x.env, x.state, x.seq])).toEqual([
        ["staging", "planned", 1],
        ["production", "planned", 2],
      ]);
      await expect(r.service.deploy({ record: production?.id ?? 0 }, "owner")).rejects.toThrow(
        /storefront staging is not live/,
      );
      const out = await r.service.deploy({ record: staging?.id ?? 0 }, "captain");
      expect(out.record.commit).toBe(C1);
      await r.service.idle();
      const next = await r.service.deploy({ record: production?.id ?? 0 }, "owner");
      expect(next.repeat).toBe(false);
      await r.service.idle();
      expect(r.store.deploys.get(production?.id ?? 0)).toMatchObject({ state: "live", commit: C1 });
    });
  });
});
