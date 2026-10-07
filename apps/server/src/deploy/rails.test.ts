import type { DeployEnvironment } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { environmentsProblem } from "./rails.ts";
import { C1, environment, GH, push, type Rig, rig } from "./testing/rig.ts";

/** What the captain may not do to a project's deploys, whatever its prompt says. */

const prod: DeployEnvironment = { env: "production", tier: "production" };
const staging: DeployEnvironment = { env: "staging", tier: "staging" };

describe("environments the captain changes", () => {
  it("never sets a tier to staging, not even on an environment that is production", () => {
    expect(environmentsProblem([prod], [prod, { env: "qa", tier: "staging" }], "captain")).toContain(
      "Only the owner sets qa to staging",
    );
    expect(environmentsProblem([prod], [{ ...prod, tier: "staging" }], "captain")).toContain(
      "Only the owner sets production to staging",
    );
  });

  it("never removes a production environment, and may add one and set its branch and check", () => {
    expect(environmentsProblem([prod, staging], [staging], "captain")).toContain(
      "Only the owner removes a production environment (production)",
    );
    expect(
      environmentsProblem(
        [prod],
        [
          { ...prod, branch: "main", check: "https://acme.example/health" },
          { env: "app/acme", tier: "production" },
        ],
        "captain",
      ),
    ).toBeUndefined();
  });

  it("lets the owner do all of it", () => {
    expect(
      environmentsProblem([prod, staging], [{ ...staging, tier: "production" }], "owner"),
    ).toBeUndefined();
  });
});

describe("a plan the captain writes", () => {
  let r: Rig;
  afterEach(async () => {
    await r.service.idle();
    await r.hosts.close();
    r.store.close();
  });

  it("refuses an ssh run and an environment the project does not have, and writes nothing", async () => {
    r = await rig([environment("staging")]);
    push(r, C1);
    const ssh = [{ kind: "ssh" as const, connection: "acme-host", command: "./deploy.sh" }];
    await expect(
      r.service.plan(
        { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: ssh }] },
        "captain",
      ),
    ).rejects.toThrow(/ssh run is the owner's/);
    await expect(
      r.service.plan({ task: "ACM-1", steps: [{ project: "storefront", env: "prod", runs: GH }] }, "captain"),
    ).rejects.toThrow(/has no prod environment/);
    expect(r.store.deploys.ofTask("ACM-1")).toEqual([]);
    // The owner may plan an ssh run.
    const owned = await r.service.plan(
      { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: ssh }] },
      "owner",
    );
    expect(owned.records).toHaveLength(1);
  });

  it("refuses a task of another workspace and a step twice", async () => {
    r = await rig([environment("staging")]);
    await expect(
      r.service.plan(
        { task: "GLX-9", steps: [{ project: "storefront", env: "staging", runs: GH }] },
        "captain",
      ),
    ).rejects.toThrow(/not in the workspace/);
    await expect(
      r.service.plan(
        {
          task: "ACM-1",
          steps: [
            { project: "storefront", env: "staging", runs: GH },
            { project: "storefront", env: "staging", runs: GH },
          ],
        },
        "captain",
      ),
    ).rejects.toThrow(/in the plan twice/);
  });

  it("holds a step for a migration, and a held step never runs by a rule", async () => {
    r = await rig([environment("staging")]);
    push(r, C1);
    const { records } = await r.service.plan(
      { task: "ACM-1", steps: [{ project: "storefront", env: "staging", runs: GH, hold: "migration" }] },
      "captain",
    );
    expect(records[0]?.state).toBe("held");
    expect(r.hosts.calls).toEqual([]);
  });
});
