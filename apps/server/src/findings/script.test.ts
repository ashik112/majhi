import type { Finding, FindingsList, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";

/** A real captain turn, scripted through the fake agent, reports findings and proposes a task. */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

async function lane() {
  w = await bossWorld();
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  return { w, h, chat };
}

const list = async (world: BossWorld, org?: string): Promise<Finding[]> =>
  ((await world.h.cmd("findings.list", org === undefined ? {} : { org })).body as FindingsList).findings;

describe("findings through a captain turn", () => {
  it("reports a finding twice (one finding), then proposes a task that waits in the inbox", async () => {
    const { w: world, h, chat } = await lane();
    const script = await captainScript(
      world,
      [
        {
          when: /Wake: findings/,
          steps: [
            {
              tool: "majhi_findings_report",
              args: {
                source: "ci",
                project: "acme-api",
                title: "Flaky test in the api suite",
                detail: "The retry test fails one run in five.",
                evidence: ["ci run 4412", "api/retry.test.ts:31"],
                severity: "medium",
                reason: "the CI sweep",
              },
            },
            {
              tool: "majhi_findings_report",
              args: {
                source: "ci",
                project: "acme-api",
                title: "Flaky test in the api suite",
                evidence: ["ci run 4415"],
                reason: "seen again",
              },
            },
            { tool: "majhi_findings_toTask", args: { id: 1, reason: "worth fixing" } },
            { say: "Reported and proposed." },
          ],
        },
      ],
      { task: chat },
    );

    await h.majhi.services.lanes.tell("acme", "Wake: findings sweep", "wake");
    const calls = await script.calls(3);
    expect(calls.map((c) => [c.tool, c.isError])).toEqual([
      ["majhi_findings_report", false],
      ["majhi_findings_report", false],
      ["majhi_findings_toTask", false],
    ]);

    // The project card's own readiness gaps are findings too (source setup); this test is about the turn's.
    const [finding, ...rest] = (await list(world)).filter((f) => f.source !== "setup");
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      org: "acme",
      project: "acme-api",
      source: "ci",
      status: "proposed",
      seen: 2,
      by: "captain",
      evidence: ["ci run 4412", "api/retry.test.ts:31", "ci run 4415"],
    });
    const task = h.majhi.services.store.tasks.get(finding?.task ?? "");
    expect(task).toMatchObject({ title: "Flaky test in the api suite", status: "inbox", org: "acme" });
    expect(task?.repos.map((r) => r.project)).toEqual(["acme-api"]);
  });

  it("refuses a lane that reaches for another workspace, and shows it only its own findings", async () => {
    const { w: world, h, chat } = await lane();
    expect((await h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" })).status).toBe(200);
    const theirs = await h.cmd("findings.report", {
      org: "globex",
      source: "security",
      title: "Globex secret in a log line",
    });
    expect(theirs.status).toBe(200);
    const id = (theirs.body as { finding: Finding }).finding.id;
    const mine = await h.cmd("findings.report", { org: "acme", source: "ci", title: "Acme build is slow" });
    expect(mine.status).toBe(200);

    const seen: string[] = [];
    const script = await captainScript(
      world,
      [
        {
          when: /Wake: findings/,
          steps: [
            { tool: "majhi_findings_list", args: { org: "globex", reason: "look" } },
            { tool: "majhi_findings_dismiss", args: { id, reason: "not mine" } },
            { tool: "majhi_findings_toTask", args: { id, reason: "make it" } },
            { tool: "majhi_findings_list", args: { reason: "mine" } },
          ],
        },
      ],
      { task: chat, onResult: (r) => seen.push(r.text) },
    );
    await h.majhi.services.lanes.tell("acme", "Wake: findings sweep", "wake");
    const calls = await script.calls(4);

    // The Globex list is refused or empty, and the changes are refused.
    expect(calls[1]?.isError).toBe(true);
    expect(calls[2]?.isError).toBe(true);
    expect(seen[0] ?? "").not.toContain("Globex secret");
    expect(seen[3] ?? "").toContain("Acme build is slow");
    expect(seen.join("\n")).not.toContain("Globex secret");
    const after = await list(world, "globex");
    expect(after.map((f) => [f.title, f.status])).toEqual([["Globex secret in a log line", "open"]]);
    expect(
      h.majhi.services.store.tasks.list(false).filter((t: Pick<Task, "org">) => t.org === "globex"),
    ).toEqual([]);
  });
});
