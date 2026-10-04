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
  it("the owner's goal is active; the captain's is a proposal in its own workspace", async () => {
    const goals = setup();
    const mine = await goals.create(
      { org: "business", title: "$10k monthly revenue", target: "$10k" },
      OWNER,
    );
    expect(mine).toMatchObject({ status: "active", by: "owner", org: "business", id: "10k-monthly-revenue" });
    const proposed = await goals.create(
      { org: "acme", title: "99.9% uptime for Acme", metric: "uptime" },
      ACME,
    );
    expect(proposed).toMatchObject({ status: "proposed", by: "captain", org: "acme" });
    expect(goals.list({}, OWNER).map((g) => g.status)).toEqual(["proposed", "active"]);
  });

  it("the captain cannot set a business goal, a goal for another workspace, or confirm its own", async () => {
    const goals = setup();
    await expect(goals.create({ org: "business", title: "Take over" }, ACME)).rejects.toThrow(
      /Only the owner/,
    );
    await expect(goals.create({ org: "globex", title: "Not mine" }, ACME)).rejects.toThrow(
      /your own workspace/,
    );
    const g = await goals.create({ org: "acme", title: "Launch in November" }, ACME);
    expect(() => goals.update({ id: g.id, status: "active" }, ACME)).toThrow(/Only the owner confirms/);
    expect(goals.update({ id: g.id, title: "Launch on a directory in November" }, ACME).title).toMatch(
      /directory/,
    );
    expect(goals.update({ id: g.id, status: "active" }, OWNER).status).toBe("active");
    // Once confirmed it is the owner's.
    expect(() => goals.update({ id: g.id, title: "Mine now" }, ACME)).toThrow(/Only the owner changes/);
  });

  it("a captain lane cannot touch another workspace's goal", async () => {
    const goals = setup();
    const theirs = await goals.create({ org: "globex", title: "Globex launch" }, OWNER);
    expect(() => goals.update({ id: theirs.id, title: "x" }, ACME)).toThrow(/not in your workspace/);
    expect(goals.list({}, ACME).map((g) => g.id)).not.toContain(theirs.id);
  });

  it("makes unique ids from the title, even for the same title twice", async () => {
    const goals = setup();
    const a = await goals.create({ org: "acme", title: "Ship v2" }, OWNER);
    const b = await goals.create({ org: "acme", title: "Ship v2" }, OWNER);
    expect([a.id, b.id]).toEqual(["ship-v2", "ship-v2-2"]);
  });

  it("refuses an unknown workspace and links only to goals that are not dropped", async () => {
    const goals = setup();
    await expect(goals.create({ org: "nowhere", title: "x" }, OWNER)).rejects.toThrow(/no workspace/);
    const g = await goals.create({ org: "acme", title: "Grow" }, OWNER);
    expect(goals.linkable(g.id, "acme")).toBe(true);
    expect(goals.linkable(g.id, "globex")).toBe(false);
    goals.update({ id: g.id, status: "dropped" }, OWNER);
    expect(goals.linkable(g.id, "acme")).toBe(false);
  });
});
