import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { type GoalActor, GoalsService } from "./goals.ts";

/** Goals: the captain proposes, the owner confirms, and a lane stays in its workspace. */

const OWNER: GoalActor = { kind: "owner" };
const ACME: GoalActor = { kind: "captain", org: "acme" };

function setup() {
  return new GoalsService({
    db: new Store(":memory:").raw,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    knownOrg: async (o) => o === "acme" || o === "globex",
  });
}

describe("goals", () => {
  it("the captain cannot set a business goal, a goal for another workspace, or confirm its own", async () => {
    const goals = setup();
    await expect(goals.create({ org: "business", title: "Take over" }, ACME)).rejects.toThrow();
    await expect(goals.create({ org: "globex", title: "Not mine" }, ACME)).rejects.toThrow();
    const g = await goals.create({ org: "acme", title: "Launch in November" }, ACME);
    expect(() => goals.update({ id: g.id, status: "active" }, ACME)).toThrow();
    expect(goals.update({ id: g.id, status: "active" }, OWNER).status).toBe("active");
    // Once confirmed it is the owner's.
    expect(() => goals.update({ id: g.id, title: "Mine now" }, ACME)).toThrow();
  });

  it("a captain lane cannot touch another workspace's goal", async () => {
    const goals = setup();
    const theirs = await goals.create({ org: "globex", title: "Globex launch" }, OWNER);
    expect(() => goals.update({ id: theirs.id, title: "x" }, ACME)).toThrow();
    expect(goals.list({}, ACME).map((g) => g.id)).not.toContain(theirs.id);
  });
});
