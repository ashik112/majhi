import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type HandoffResult,
  type HandoffState,
  type HandoffStep,
  type MergeChecks,
  mergeVerdictAction,
  type QueuedMerge,
  type Task,
} from "@majhi/shared";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../store/migrations.ts";
import { type QueuedMergePorts, QueuedMerges } from "../tasks/queued-merge.ts";
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
  expect((await h.cmd("authority.set", { org: "acme", level: "ask" })).status).toBe(200);
  const made = await h.cmd("tasks.create", {
    text: "Fix it.",
    repos: [{ project: "acme-api" }],
    start: false,
  });
  const id = (made.body as Task).id;
  await h.cmd("room.send", { task: id, text: "create acme-api/work.txt" });
  await w.until(async () => ((await h.cmd("tasks.get", { id })).body as Task).status === "review", "review");
  // `handoff.get` runs git, so it is asked once the checks have settled, not on every tick of a wait.
  // A check that has not started yet leaves nothing to settle, so ask again after it does.
  do await h.majhi.services.handoff.settled();
  while ((await handoff(id)).history.length === 0);
  // The status reads review when the turn ends, a moment before the run lets go of the task, and merging
  // in that gap is refused as "an agent is working": wait for the thing the merge checks.
  await w.until(() => h.majhi.services.runs.working(id).length === 0, "the agent to stop working");
  return { w, h, id, repo };
}
const handoff = async (id: string) =>
  ((await w?.h.cmd("handoff.get", { task: id }))?.body ?? {}) as HandoffState;
const tip = (repo: string, ref: string) => git(repo, "rev-parse", ref).then((s) => s.trim());

describe("the merge rule", { timeout: 90_000 }, () => {
  it.each<[string, () => Promise<void>]>([
    [
      "a failed check, an agent, a wrong sha",
      async () => {
        const { h, id, repo } = await reviewed('\t@test ! -f work.txt || { echo "FAIL: nope"; exit 1; }');
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
        const wrong = await h.cmd("tasks.merge", {
          id,
          into: "main",
          done: true,
          confirmChecks: "api@000000",
        });
        expect(wrong.status).toBe(409);
        expect(await tip(repo, "main")).toBe(before);

        // The owner with the head of this merge: it merges, and the override is in the trail.
        const ok = await h.cmd("tasks.merge", { id, into: "main", done: true, confirmChecks: head });
        expect(ok.status).toBe(200);
        expect(await tip(repo, "main")).not.toBe(before);
        const audit = await h.cmd("audit.list", { task: id });
        expect(JSON.stringify(audit.body)).toContain("merge-override");
      },
    ],
    [
      "a head that moved after the merge was queued, even when the new head is green",
      async () => {
        const db = new Database(":memory:");
        const table = MIGRATIONS.find((m) => m.name === "queued merges");
        if (table === undefined) throw new Error("no migration");
        db.exec(table.sql);
        const merged: QueuedMerge[] = [];
        const refused: string[] = [];
        let checks: MergeChecks = { head: "api@aaaaaaaaaaaa", verdict: { kind: "running" } };
        const ports: QueuedMergePorts = {
          task: (id) => ({ id, status: "review", repos: 1 }),
          checks: async () => checks,
          run: async (q) => {
            merged.push(q);
            return undefined;
          },
          say: () => undefined,
          refuse: (_t, text) => refused.push(text),
          changed: () => undefined,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
        };
        const queued = new QueuedMerges(db, ports);
        await queued.request({
          task: "ACM-1",
          action: "merge",
          into: "main",
          method: "merge",
          deleteAfter: false,
          by: "owner",
        });
        checks = { head: "api@bbbbbbbbbbbb", verdict: { kind: "ok" } };
        await queued.evaluate("ACM-1");
        expect(merged).toHaveLength(0);
        expect(queued.get("ACM-1")).toBeUndefined();
        expect(refused).toHaveLength(1);
      },
    ],
  ])("merges only with green checks on the exact head: refuses %s", async (_name, run) => {
    await run();
  });
});
