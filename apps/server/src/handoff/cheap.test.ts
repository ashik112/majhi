import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffState, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ASK } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { git } from "../testing/fixtures.ts";

/**
 * The cheap checks of the hand-off against real git: a secret added to the diff, and a conflict that
 * appears after a green check. Autonomous stays off, so nobody is told and nothing ships.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const who = ["-c", "user.name=Builder", "-c", "user.email=builder@example.com"];
const status = async (world: BossWorld, id: string) =>
  ((await world.h.cmd("tasks.get", { id })).body as Task).status;
const handoff = async (world: BossWorld, id: string) =>
  (await world.h.cmd("handoff.get", { task: id })).body as HandoffState;

/** A task in review whose first check was judged green. The fake agent creates `work.txt` on request. */
async function reviewed() {
  const world = await bossWorld();
  w = world;
  const { h } = world;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: ASK } } })).status).toBe(200);
  const made = await h.cmd("tasks.create", {
    text: "Fix it.",
    repos: [{ project: "acme-api" }],
    start: false,
  });
  const id = (made.body as Task).id;
  expect((await h.cmd("room.send", { task: id, text: "create acme-api/work.txt" })).status).toBe(200);
  await world.until(async () => (await status(world, id)) === "review", "review");
  await world.until(async () => (await handoff(world, id)).history.length > 0, "the first check");
  await h.majhi.services.handoff.settled();
  return { world, h, id, tree: join(world.taskDir(id), "acme-api") };
}

describe("the cheap checks in a real repository", { timeout: 60_000 }, () => {
  it("a secret added to the diff turns the check red, without printing the secret", async () => {
    const { world, h, id, tree } = await reviewed();
    expect((await handoff(world, id)).current?.verdict).toBe("green");
    const token = `ghp_${"k3J9m2P7q1".repeat(4)}`;
    await writeFile(join(tree, "leak.txt"), `token = ${token}\n`);
    await git(tree, "add", "leak.txt");
    await git(tree, ...who, "commit", "-qm", "add config");
    await h.cmd("handoff.check", { task: id });
    await world.until(async () => (await handoff(world, id)).current?.verdict === "red", "a red check");
    await h.majhi.services.handoff.settled();
    const state = await handoff(world, id);
    expect(state.current?.failures[0]).toContain("holds what looks like a secret");
    expect(JSON.stringify(state)).not.toContain(token);
  });

  it("a conflict that appears after a green check is found at once, with nothing run again", async () => {
    const { world, h, id } = await reviewed();
    expect((await handoff(world, id)).current?.verdict).toBe("green");
    // The branch the task ships to gets the same file the task added.
    const repo = world.repo("api");
    await writeFile(join(repo, "work.txt"), "main got there first\n");
    await git(repo, "add", "work.txt");
    await git(repo, ...who, "commit", "-qm", "work.txt on main");
    const later = await h.majhi.services.handoff.ensure(id, { force: false });
    expect(later.verdict).toBe("red");
    expect(later.cached).toBe(true);
    // Where the owner decides how work merges, resolving it is theirs: held, and the lead is not told.
    expect(later.held[0]).toBe("it conflicts with main in work.txt");
    expect(later.failures).toEqual([]);
    expect((await handoff(world, id)).strikes).toBe(0);
  });
});
