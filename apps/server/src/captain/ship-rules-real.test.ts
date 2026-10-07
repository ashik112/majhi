import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ALL_ASK, type ShipRule, type Task, type TaskDetail } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { git } from "../testing/fixtures.ts";

/**
 * Ship rules through a real captain, real git and real worktrees (the agent is the fake ACP agent, so
 * no token is spent): a typed bug under the line limit merges with no click, a feature asks, a secret
 * in the diff never merges whatever a rule says, and the trail says what waits for the owner.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const who = ["-c", "user.name=Builder", "-c", "user.email=builder@example.com"];

const bugRule: ShipRule = {
  id: "aaaaaaaa",
  when: { types: ["bug", "incident"], maxChangedLines: 200 },
  merge: "decide",
  deployStaging: "ask",
  deployProduction: "ask",
  tell: "ask",
};

/** A task in review with one commit in its worktree: `file` holding `content`, typed `type`. */
async function reviewed(world: BossWorld, text: string, file: string, content: string, type: string) {
  const { h } = world;
  h.runtime.onSession = (session) => {
    session.script = async (turn) => {
      void turn;
      return "end_turn";
    };
  };
  const made = await h.cmd("tasks.create", { text, repos: [{ project: "acme-api" }], start: true });
  expect(made.status).toBe(200);
  const id = (made.body as Task).id;
  await h.majhi.services.runs.idle();
  const until = Date.now() + 60_000;
  while (((await h.cmd("tasks.get", { id })).body as Task).status !== "review") {
    if (Date.now() > until) throw new Error(`${id} never reached review`);
    await new Promise((r) => setTimeout(r, 20));
  }
  const tree = join(world.taskDir(id), "acme-api");
  await writeFile(join(tree, file), content);
  await git(tree, "add", file);
  await git(tree, ...who, "commit", "-qm", `Add ${file}`);
  expect((await h.cmd("tasks.setType", { id, type })).status).toBe(200);
  return { id, tree };
}

async function shipAsCaptain(world: BossWorld, id: string, rules: ShipRule[]) {
  const { h } = world;
  const rows = { ...ALL_ASK, upkeep: "decide" as const };
  expect(
    (await h.cmd("autonomy.configure", { orgs: { acme: { authority: rows, ships: rules } } })).status,
  ).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  h.majhi.services.captain.reviewReached(id);
  await h.majhi.services.captain.settled();
}

const mainHas = async (world: BossWorld, file: string) =>
  (await git(world.repo("api"), "ls-tree", "-r", "--name-only", "main")).split("\n").includes(file);

describe("ship rules with a real captain", { timeout: 120_000 }, () => {
  it("merges a small bug under a Captain rule with no click, and says so", async () => {
    w = await bossWorld({ real: false });
    const { id } = await reviewed(w, "fix the coupon crash", "coupon.txt", "fixed\n", "bug");
    expect(await mainHas(w, "coupon.txt")).toBe(false);
    await shipAsCaptain(w, id, [bugRule]);
    expect(await mainHas(w, "coupon.txt")).toBe(true);
    expect(((await w.h.cmd("tasks.get", { id })).body as Task).status).toBe("done");
    const log = JSON.stringify((await w.h.cmd("captain.log", { org: "acme" })).body);
    expect(log).toContain("Shipped ACM-1");
    expect(log).toContain("the rule for a bug or incident up to 200 lines lets the captain merge");
  });

  it("asks for a feature the rule does not cover, and the trail says the merge waits for you", async () => {
    w = await bossWorld({ real: false });
    const { id } = await reviewed(w, "add coupon export", "export.txt", "export\n", "feature");
    await shipAsCaptain(w, id, [bugRule]);
    expect(await mainHas(w, "export.txt")).toBe(false);
    const detail = (await w.h.cmd("tasks.detail", { id })).body as TaskDetail;
    expect(detail.ship).toMatchObject({ merge: "owner", push: "owner" });
    expect(detail.trail).toContainEqual({ kind: "ship", tone: "needs", step: "merge" });
  });

  it("never merges a bug whose checks fail on its head, whatever the rule says", async () => {
    w = await bossWorld({ real: false });
    expect(
      (await w.h.cmd("projects.update", { id: "acme-api", org: "acme", handoff: { test: "exit 1" } })).status,
    ).toBe(200);
    const { id } = await reviewed(w, "fix the coupon crash", "coupon.txt", "fixed\n", "bug");
    await shipAsCaptain(w, id, [bugRule]);
    expect(await mainHas(w, "coupon.txt")).toBe(false);
    expect(((await w.h.cmd("tasks.get", { id })).body as Task).status).toBe("review");
    const log = JSON.stringify((await w.h.cmd("captain.log", { org: "acme" })).body);
    expect(log).toContain("the hand-off check failed");
  });

  it("never merges a bug whose diff holds a secret, whatever the rule says", async () => {
    w = await bossWorld({ real: false });
    const key = `AKIA${"IOSFODNN7EXAMPLE"}`;
    const { id } = await reviewed(w, "fix the coupon crash", "keys.txt", `aws_access_key_id=${key}\n`, "bug");
    await shipAsCaptain(w, id, [bugRule]);
    expect(await mainHas(w, "keys.txt")).toBe(false);
    expect(((await w.h.cmd("tasks.get", { id })).body as Task).status).toBe("review");
    const log = JSON.stringify((await w.h.cmd("captain.log", { org: "acme" })).body);
    expect(log).toContain("looks like a secret");
  });

  it("holds the captain's own lane to the same decision: it merges the bug and cannot merge the feature", async () => {
    w = await bossWorld({ real: false });
    const bug = await reviewed(w, "fix the coupon crash", "coupon.txt", "fixed\n", "bug");
    const feature = await reviewed(w, "add coupon export", "export.txt", "export\n", "feature");
    const { h } = w;
    const rows = { ...ALL_ASK, upkeep: "decide" as const };
    await h.cmd("autonomy.configure", { orgs: { acme: { authority: rows, ships: [bugRule] } } });
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const lane = await h.majhi.services.autonomy.laneChat("acme");
    if (lane === undefined) throw new Error("no lane for Acme");
    const merge = (id: string) =>
      h.majhi.services.admin.call({ task: lane, agent: "boss" }, "majhi_tasks_merge", {
        id,
        into: "main",
        done: true,
        reason: "ready",
        ownerAsked: false,
      });
    const fixed = await merge(bug.id);
    expect(fixed.isError).toBe(false);
    expect(await mainHas(w, "coupon.txt")).toBe(true);
    await merge(feature.id);
    expect(await mainHas(w, "export.txt")).toBe(false);
    expect(((await h.cmd("tasks.get", { id: feature.id })).body as Task).status).toBe("review");
  });
});
