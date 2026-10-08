import {
  type Goal,
  type OutboundList,
  type PlaybookRun,
  PlaybookSchema,
  type PlaybooksList,
} from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";

/** A real captain turn, scripted through the fake agent, runs a playbook, files a finding and drafts a message. */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const SWEEP = PlaybookSchema.parse({
  id: "e2e-sweep",
  name: "Dependency check",
  pack: "engineering",
  purpose: "Look at the lockfiles and report what is out of date.",
  trigger: { cadence: { kind: "manual" }, events: [] },
  inputs: ["lockfiles of registered projects"],
  steps:
    "Read each lockfile. Report an outdated package as a finding. Draft a note to the vendor if one is needed.",
  outputs: ["finding", "draft"],
  channels: ["email"],
  cost: { tier: "small", tokens: 50_000 },
  enabledByDefault: false,
  turnOn: "Checks lockfiles.",
  runner: { kind: "captain" },
});

async function lane() {
  w = await bossWorld();
  const { h } = w;
  expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
  expect((await h.cmd("autonomy.start")).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme", "backlog");
  if (chat === undefined) throw new Error("no lane for Acme");
  h.majhi.services.playbooks.catalog.register(SWEEP);
  return { w, h, chat };
}

const runs = async (world: BossWorld) =>
  (await world.h.cmd("playbooks.runs", { org: "acme", id: "e2e-sweep" })).body.runs as PlaybookRun[];

describe("a playbook through a captain turn", () => {
  it("a turn that goes wrong: wrong run id, the owner's switches, a business goal and Auto are all refused, and a blocked report backs off", async () => {
    const { w: world, h, chat } = await lane();
    const seen: string[] = [];
    const script = await captainScript(
      world,
      [
        {
          when: /Playbook "Dependency check" is due in /,
          steps: [
            { tool: "majhi_playbooks_report", args: { run: 99, outcome: "done", reason: "wrong id" } },
            {
              tool: "majhi_playbooks_update",
              args: { org: "acme", id: "e2e-sweep", outcomes: { "sweep-brief": true }, reason: "more room" },
            },
            {
              tool: "majhi_outbound_setMode",
              args: { org: "acme", channel: "email", mode: "auto", explicit: true, reason: "faster" },
            },
            {
              tool: "majhi_goals_create",
              args: { org: "business", title: "Take over the world", reason: "ambition" },
            },
            {
              tool: "majhi_goals_create",
              args: { org: "acme", title: "99.9% uptime for Acme", metric: "uptime", reason: "a goal" },
            },
            {
              tool: "majhi_playbooks_report",
              args: {
                run: 1,
                outcome: "blocked",
                summary: "I cannot read the lockfiles.",
                reason: "blocked",
              },
            },
          ],
        },
      ],
      { task: chat, onResult: (r) => seen.push(r.text) },
    );
    await h.cmd("playbooks.update", { org: "acme", id: "e2e-sweep", enabled: true });
    await h.cmd("playbooks.run", { org: "acme", id: "e2e-sweep" });
    const calls = await script.calls(6);
    expect(calls.map((c) => c.isError)).toEqual([true, true, true, true, false, false]);

    // The owner's switches did not move.
    const list = (await h.cmd("playbooks.list", { org: "acme" })).body as PlaybooksList;
    expect(list.playbooks.find((p) => p.playbook.id === "e2e-sweep")?.enabled).toBe(true);
    const gate = (await h.cmd("outbound.list", { org: "acme" })).body as OutboundList;
    expect(gate.channels.find((c) => c.channel === "email")?.mode).toBe("draft");
    // The goal it may set is a proposal in its own workspace.
    const goals = (await h.cmd("goals.list", {})).body.goals as Goal[];
    expect(goals.map((g) => [g.title, g.status, g.org])).toEqual([
      ["99.9% uptime for Acme", "proposed", "acme"],
    ]);

    // The blocked report failed the run, and the playbook backs off.
    const [run] = await runs(world);
    expect(run).toMatchObject({ status: "failed", note: "I cannot read the lockfiles." });
    const again = await h.cmd("playbooks.run", { org: "acme", id: "e2e-sweep" });
    expect(again.status).toBe(200);
    const view = ((await h.cmd("playbooks.list", { org: "acme" })).body as PlaybooksList).playbooks.find(
      (p) => p.playbook.id === "e2e-sweep",
    );
    expect(view?.held).toBeDefined();
  });

  it("turning Autonomous off stops the playbook, and a disabled one never wakes the captain", async () => {
    const { w: world, h } = await lane();
    expect((await h.cmd("playbooks.run", { org: "acme", id: "e2e-sweep" })).body).toMatchObject({
      started: false,
    });
    expect(await runs(world)).toEqual([]);
    await h.cmd("playbooks.update", { org: "acme", id: "e2e-sweep", enabled: true });
    expect((await h.cmd("autonomy.stop", { how: "now" })).status).toBe(200);
    const off = (await h.cmd("playbooks.run", { org: "acme", id: "e2e-sweep" })).body as {
      started: boolean;
      text: string;
    };
    expect(off).toMatchObject({ started: false });
    expect(await runs(world)).toEqual([]);
  });
});
