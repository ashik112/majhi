import { ALL_ASK, type CaptainCapAsk } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "../store/index.ts";
import { LaneGate } from "./lane-gate.ts";
import type { CaptainPorts, ShipCheck } from "./ports.ts";
import { CaptainRepo } from "./repo.ts";
import { DAILY_CAPS } from "./rules.ts";
import type { Workspace } from "./runner.ts";

/** The lane's ships and repo registrations are held to the chores' rules, over a database in memory. */

const DAY = "2026-10-03";

function setup(rules?: Workspace["rules"]) {
  const repo = new CaptainRepo(new Store(":memory:").raw);
  const state = {
    heads: "acme-api@abc123",
    check: {
      ready: true,
      evidence: "committed, merges cleanly into main",
      targets: [{ project: "acme-api", into: "main", base: "main" }],
    } as ShipCheck,
    inReview: true,
    repos: [{ path: "/Users/owner/Work/acme/web" }] as { path: string }[],
  };
  const asked: CaptainCapAsk[] = [];
  const ports = {
    reviewTasks: async () => (state.inReview ? [{ id: "ACM-1", title: "Fix", heads: state.heads }] : []),
    shipCheck: async () => state.check,
    newRepos: async () => state.repos,
  } as unknown as Pick<CaptainPorts, "reviewTasks" | "shipCheck" | "newRepos">;
  const gate = new LaneGate({
    repo,
    ports,
    workspace: async (org) => ({
      org,
      name: "Acme",
      mode: "on",
      authority: { ...ALL_ASK, merge: "decide" },
      // The owner's ship cap: where the captain decides merges, ships have no default cap.
      rules: { ...rules, chores: { ship: { actions: DAILY_CAPS.ship.actions ?? 5 }, ...rules?.chores } },
      tz: "UTC",
      day: DAY,
    }),
    now: () => new Date(`${DAY}T12:00:00.000Z`),
    capAsked: (a) => asked.push(a),
  });
  return { repo, state, gate, asked };
}

const merge = (id = "ACM-1") => ({ id, into: "main" });

describe("the lane's ships and the chore's are one rule set", () => {
  it("lets a ready task through, then counts it in the chore's log so the same state is not shipped twice", async () => {
    const t = setup();
    expect(await t.gate.check("acme", "tasks.merge", merge())).toBeUndefined();
    // The task leaves review when it ships: the key was kept from the check.
    t.state.inReview = false;
    await t.gate.ran("acme", "tasks.merge", merge(), "ready", { ok: true });
    expect(t.repo.actionsToday("acme", "ship", DAY)).toBe(1);
    expect(t.repo.hasAction("ship:ACM-1:acme-api@abc123")).toBe(true);
    // The chore's key for this state is taken: a second ship of it is refused.
    t.state.inReview = true;
    expect(await t.gate.check("acme", "tasks.merge", merge())).toContain("already");
    // New commits are a new state.
    t.state.heads = "acme-api@def456";
    expect(await t.gate.check("acme", "tasks.merge", merge())).toBeUndefined();
  });

  it("stops at the chore's daily cap of ships, counting the chore's own, and asks the owner once", async () => {
    const t = setup();
    const cap = DAILY_CAPS.ship.actions ?? 0;
    for (let i = 0; i < cap - 1; i++) {
      // The chore's own ships.
      t.repo.addAction({
        key: `ship:ACM-${100 + i}:x`,
        org: "acme",
        chore: "ship",
        day: DAY,
        at: `${DAY}T10:00:00.000Z`,
        text: "Shipped",
        reason: "chore",
        outcome: "done",
      });
    }
    expect(await t.gate.check("acme", "tasks.merge", merge())).toBeUndefined();
    await t.gate.ran("acme", "tasks.merge", merge(), "", { ok: true });
    t.state.heads = "acme-api@next";
    const refused = await t.gate.check("acme", "tasks.merge", merge());
    expect(refused).toContain(`today's cap of ${cap}`);
    expect(await t.gate.check("acme", "tasks.resolveShip", merge())).toContain("cap");
    expect(t.asked).toHaveLength(1);
    // Yesterday's ships do not count.
    t.repo.addAction({
      key: "ship:old",
      org: "acme",
      chore: "ship",
      day: "2026-10-02",
      at: "2026-10-02T10:00:00.000Z",
      text: "Shipped",
      reason: "chore",
      outcome: "done",
    });
    expect(t.repo.actionsToday("acme", "ship", DAY)).toBe(cap);
  });

  it("holds the lane to the chore's checks: not ready, a branch the workspace does not ship to", async () => {
    const t = setup();
    t.state.check = { ready: false, why: "the diff of acme-api holds what looks like a secret" };
    expect(await t.gate.check("acme", "tasks.merge", merge())).toContain("looks like a secret");
    t.state.check = {
      ready: true,
      evidence: "ok",
      targets: [{ project: "acme-api", into: "main", base: "main" }],
    };
    // Only main is shipped to; the lane asks for release.
    expect(await t.gate.check("acme", "tasks.merge", { id: "ACM-1", into: "release" })).toContain(
      "release is not a branch Acme ships to",
    );
    expect(
      await t.gate.check("acme", "tasks.merge", { id: "ACM-1", targets: { "acme-api": "release" } }),
    ).toContain("not a branch");
  });

  it("counts a failed ship without taking the task's key, so it can be tried again", async () => {
    const t = setup();
    expect(await t.gate.check("acme", "tasks.merge", merge())).toBeUndefined();
    await t.gate.ran("acme", "tasks.merge", merge(), "", { ok: false, error: "conflicts" });
    expect(t.repo.hasAction("ship:ACM-1:acme-api@abc123")).toBe(false);
    expect(t.repo.actionsToday("acme", "ship", DAY)).toBe(0);
    expect(await t.gate.check("acme", "tasks.merge", merge())).toBeUndefined();
  });

  it("asks the lead to resolve a conflict once per state, not in a loop", async () => {
    const t = setup();
    expect(await t.gate.check("acme", "tasks.resolveShip", merge())).toBeUndefined();
    await t.gate.ran("acme", "tasks.resolveShip", merge(), "", { ok: true });
    expect(await t.gate.check("acme", "tasks.resolveShip", merge())).toContain("already");
    // A ship of the same state is a different key: the resolve does not use up the merge.
    expect(await t.gate.check("acme", "tasks.merge", merge())).toBeUndefined();
  });

  it("registers only the repos the projects chore would: unregistered, in the workspace's folder", async () => {
    const t = setup();
    expect(
      await t.gate.check("acme", "projects.register", { id: "acme-web", path: "/Users/owner/Work/acme/web" }),
    ).toBeUndefined();
    const elsewhere = await t.gate.check("acme", "projects.register", {
      id: "keys",
      path: "/Users/owner/.ssh",
    });
    expect(elsewhere).toContain("not an unregistered repo");
    expect(elsewhere).toContain("/Users/owner/Work/acme/web");
    t.state.repos = [];
    expect(await t.gate.check("acme", "projects.register", { id: "x", path: "/Users/owner/.ssh" })).toContain(
      "nothing to register",
    );
  });

  it("covers the commands it should, and leaves the rest alone", async () => {
    const t = setup();
    for (const c of ["tasks.merge", "tasks.mergeMrs", "tasks.resolveShip", "projects.register"])
      expect(t.gate.covers(c)).toBe(true);
    expect(t.gate.covers("tasks.push")).toBe(false);
    expect(await t.gate.check("acme", "tasks.create", {})).toBeUndefined();
  });
});
