import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HandoffResult, HandoffState, HandoffStep, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ASK } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { git } from "../testing/fixtures.ts";
import { decideMerge } from "./merge-gate.ts";

/**
 * The merge rule: nothing merges unless the hand-off checks are green for the exact commit. The
 * verdict is typed; these tests read the verdict, the refusal and what the repo holds afterwards.
 */

const step = (id: HandoffStep["id"], status: HandoffStep["status"]): HandoffStep => ({
  id,
  label: id,
  status,
  detail: "",
});
const result = (head: string, steps: HandoffStep[]): HandoffResult => ({
  task: "ACM-1",
  head,
  at: "2026-01-01T00:00:00.000Z",
  verdict: "green",
  steps,
  review: { by: "code", notes: [], tokens: 0 },
  failures: [],
  held: [],
  ms: 1,
  cached: false,
  summary: "",
});
const green = [step("tests", "pass"), step("build", "pass"), step("lint", "pass")];
const idle = { running: false, queued: false };

describe("decideMerge", () => {
  it("is ok for green checks on the exact head", () => {
    expect(
      decideMerge({
        configured: true,
        head: "api@a1",
        state: { ...idle, current: result("api@a1", green) },
      }),
    ).toEqual({ kind: "ok" });
  });

  it("names the failed check", () => {
    expect(
      decideMerge({
        configured: true,
        head: "api@a1",
        state: {
          ...idle,
          current: result("api@a1", [step("tests", "fail"), step("build", "pass"), step("lint", "pass")]),
        },
      }),
    ).toEqual({ kind: "failed", check: "test" });
    // A test that failed and then passed on a retry is flaky, which is not green.
    expect(
      decideMerge({
        configured: true,
        head: "api@a1",
        state: {
          ...idle,
          current: result("api@a1", [step("tests", "pass"), step("build", "pass"), step("lint", "flaky")]),
        },
      }),
    ).toEqual({ kind: "failed", check: "lint" });
  });

  it("is stale when the checks ran on an older head or never ran", () => {
    expect(
      decideMerge({
        configured: true,
        head: "api@b2",
        state: { ...idle, current: result("api@a1", green) },
      }),
    ).toEqual({ kind: "stale", ran: true });
    expect(decideMerge({ configured: true, head: "api@b2", state: { ...idle, current: undefined } })).toEqual(
      {
        kind: "stale",
        ran: false,
      },
    );
    // Skipped steps are no evidence.
    expect(
      decideMerge({
        configured: true,
        head: "api@a1",
        state: {
          ...idle,
          current: result("api@a1", [
            step("tests", "skipped"),
            step("build", "skipped"),
            step("lint", "skipped"),
          ]),
        },
      }),
    ).toEqual({ kind: "stale", ran: false });
  });

  it("waits while a check of the head runs, and does not block a project with no checks", () => {
    const running: Pick<HandoffState, "current" | "running" | "queued"> = {
      current: result("api@a1", green),
      running: true,
      queued: false,
    };
    expect(decideMerge({ configured: true, head: "api@b2", state: running })).toEqual({ kind: "running" });
    expect(decideMerge({ configured: false, head: "api@b2", state: undefined })).toEqual({
      kind: "ok",
      noChecks: true,
    });
  });
});

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});
const who = ["-c", "user.name=Builder", "-c", "user.email=builder@example.com"];

/** Acme with a Makefile test, Autonomous off, and a task in review whose check has been judged. */
async function reviewed(testBody: string, withChecks = true) {
  w = await bossWorld();
  const { h } = w;
  const repo = w.repo("api");
  if (withChecks) {
    await writeFile(join(repo, "Makefile"), `test:\n${testBody}\n`);
    await git(repo, "add", "Makefile");
    await git(repo, ...who, "commit", "-qm", "add the test");
  }
  await git(repo, "branch", "-f", "develop", "main");
  await git(repo, "push", "--quiet", "origin", "main", "develop");
  await h.majhi.services.cards.refresh("acme-api");
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: ASK } } })).status).toBe(200);
  const made = await h.cmd("tasks.create", {
    text: "Fix it.",
    repos: [{ project: "acme-api" }],
    start: false,
  });
  const id = (made.body as Task).id;
  await h.cmd("room.send", { task: id, text: "create acme-api/work.txt" });
  await w.until(async () => ((await h.cmd("tasks.get", { id })).body as Task).status === "review", "review");
  await w.until(async () => (await handoff(id)).history.length > 0, "the check judged");
  await h.majhi.services.handoff.settled();
  return { w, h, id, repo };
}
const handoff = async (id: string) =>
  ((await w?.h.cmd("handoff.get", { task: id }))?.body ?? {}) as HandoffState;
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref).then((s) => s.trim());

describe("the merge rule", { timeout: 90_000 }, () => {
  it("refuses a failed check, cannot be overridden by an agent or a wrong sha, and lets the owner confirm the head", async () => {
    const { h, id, repo } = await reviewed('\t@echo "FAIL: nope"; exit 1');
    const options = (await h.cmd("tasks.shipOptions", { id })).body;
    expect(options.checks.verdict).toEqual({ kind: "failed", check: "test" });
    const head = options.checks.head as string;
    const before = await tip(repo, "main");

    // The owner without a confirmation, the captain and an agent: refused as the failed test check.
    const plain = await h.cmd("tasks.merge", { id, into: "main", done: true });
    expect(plain.status).toBe(409);
    expect(plain.body.error).toContain("The test check failed on this commit.");
    for (const actor of [
      { kind: "agent", id: "acme-builder" },
      { kind: "agent", id: "boss" },
    ]) {
      const agent = await h.cmd("tasks.merge", { id, into: "main", done: true }, { actor, task: id });
      expect(agent.status).toBe(409);
      expect(agent.body.error).toContain("The test check failed on this commit.");
      // They cannot send the confirmation either.
      const forced = await h.cmd(
        "tasks.merge",
        { id, into: "main", done: true, confirmChecks: head },
        { actor, task: id },
      );
      expect(forced.status).toBe(409);
      expect(forced.body.error).toBe("Only the owner can merge past a failed check.");
    }
    expect(await tip(repo, "main")).toBe(before);

    // A wrong sha is refused.
    const wrong = await h.cmd("tasks.merge", { id, into: "main", done: true, confirmChecks: "api@000000" });
    expect(wrong.status).toBe(409);
    expect(await tip(repo, "main")).toBe(before);

    // The owner with the head of this merge: it merges, and the override is in the trail.
    const ok = await h.cmd("tasks.merge", { id, into: "main", done: true, confirmChecks: head });
    expect(ok.status).toBe(200);
    expect(await tip(repo, "main")).not.toBe(before);
    const audit = await h.cmd("audit.list", { task: id });
    expect(JSON.stringify(audit.body)).toContain("merge-override");
  });

  it("refuses while a check runs and after a new commit, and merges once the exact head is green", async () => {
    const { h, w: world, id, repo } = await reviewed("\t@echo ok");
    expect((await h.cmd("tasks.shipOptions", { id })).body.checks.verdict).toEqual({ kind: "ok" });

    // A new commit on the task's branch: the green result belongs to the older head.
    const tree = join(world.taskDir(id), "acme-api");
    await writeFile(join(tree, "more.txt"), "more\n");
    await git(tree, "add", ".");
    await git(tree, ...who, "commit", "-qm", "more");
    const before = await tip(repo, "main");
    const stale = await h.cmd("tasks.merge", { id, into: "main", done: true });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("The checks ran on an older commit");
    expect(await tip(repo, "main")).toBe(before);

    // A check of the new head is running: wait.
    await h.cmd("handoff.check", { task: id });
    const running = await h.cmd("tasks.merge", { id, into: "main", done: true });
    expect(running.status).toBe(409);
    expect(running.body.error).toContain("still running");
    expect(await tip(repo, "main")).toBe(before);

    await h.majhi.services.handoff.settled();
    const merged = await h.cmd("tasks.merge", { id, into: "main", done: true });
    expect(merged.status).toBe(200);
    expect(await tip(repo, "main")).not.toBe(before);
  });

  it("does not block a project with no checks set up", async () => {
    const { h, id, repo } = await reviewed("", false);
    const options = (await h.cmd("tasks.shipOptions", { id })).body;
    expect(options.checks.verdict).toEqual({ kind: "ok", noChecks: true });
    const before = await tip(repo, "main");
    const merged = await h.cmd("tasks.merge", { id, into: "main", done: true });
    expect(merged.status).toBe(200);
    expect(await tip(repo, "main")).not.toBe(before);
  });
});
