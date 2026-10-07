import { describe, expect, it } from "vitest";
import { DEPLOY_STATES, type DeployState, deployMayMove } from "./deploy.ts";

describe("deploy record moves", () => {
  it("lets a planned step be queued or held, and nothing else", () => {
    expect(deployMayMove("planned", "queued")).toBe(true);
    expect(deployMayMove("planned", "held")).toBe(true);
    const others = DEPLOY_STATES.filter((s) => s !== "queued" && s !== "held");
    for (const to of others) expect(deployMayMove("planned", to)).toBe(false);
  });

  it("never moves anything back to planned: a plan that is replaced deletes its own rows", () => {
    for (const from of DEPLOY_STATES as readonly DeployState[]) {
      expect(deployMayMove(from, "planned")).toBe(false);
    }
  });
});
