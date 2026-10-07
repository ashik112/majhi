import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type HandoffResult,
  type HandoffState,
  type HandoffStep,
  mergeVerdictAction,
  type Task,
} from "@majhi/shared";
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

  it("is blocked, not stale, when the first check failed on this head, so running again is not offered", () => {
    const ready = { ...step("ready", "fail"), detail: "it conflicts with main in docs/PROGRESS.md" };
    const skipped = [step("tests", "skipped"), step("build", "skipped"), step("lint", "skipped")];
    expect(
      decideMerge({
        configured: true,
        head: "api@a1",
        state: { ...idle, current: result("api@a1", [ready, ...skipped]) },
      }),
    ).toEqual({ kind: "blocked", why: "it conflicts with main in docs/PROGRESS.md" });
  });

  it("keeps a block only the owner can clear away from the lead, and sends the lead one it can fix", () => {
    const skipped = [step("tests", "skipped"), step("build", "skipped"), step("lint", "skipped")];
    const verdictFor = (ready: HandoffStep) =>
      decideMerge({
        configured: true,
        head: "api@a1",
        state: { ...idle, current: result("api@a1", [ready, ...skipped]) },
      });
    const card = verdictFor({
      ...step("ready", "fail"),
      detail: "an owner question card waits for you",
      owner: true,
    });
    expect(card).toEqual({ kind: "blocked", why: "an owner question card waits for you", owner: true });
    expect(mergeVerdictAction(card)).toBe("none");
    const conflict = verdictFor({ ...step("ready", "fail"), detail: "it conflicts with main in a.ts" });
    expect(mergeVerdictAction(conflict)).toBe("fix-with-agent");
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
});
