import {
  type Draft,
  type Finding,
  type FindingsList,
  type Goal,
  type OutboundList,
  type OwnerDecision,
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
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  h.majhi.services.playbooks.catalog.register(SWEEP);
  return { w, h, chat };
}

const decisions = async (world: BossWorld) =>
  (await world.h.cmd("decisions.list", {})).body.decisions as OwnerDecision[];
const outbound = async (world: BossWorld) =>
  ((await world.h.cmd("outbound.list", { org: "acme" })).body as OutboundList).drafts;
const runs = async (world: BossWorld) =>
  (await world.h.cmd("playbooks.runs", { org: "acme", id: "e2e-sweep" })).body.runs as PlaybookRun[];

describe("a playbook through a captain turn", () => {
  it("wakes the lane, files a finding, drafts a message that waits in Decisions, and closes the run", async () => {
    const { w: world, h, chat } = await lane();
    const seen: string[] = [];
    const script = await captainScript(
      world,
      [
        {
          when: /Playbook "Dependency check" is due in /,
          steps: [
            {
              tool: "majhi_findings_report",
              args: {
                source: "dependency",
                title: "left-pad is two majors behind",
                severity: "medium",
                evidence: ["pnpm-lock.yaml:1204"],
                playbook: "e2e-sweep",
                reason: "the lockfile sweep",
              },
            },
            {
              tool: "majhi_outbound_submit",
              args: {
                channel: "email",
                target: "support@vendor.example",
                subject: "Question about the 3.0 migration",
                body: "Hello, we are two majors behind and would like the upgrade notes. Thank you.",
                voice: "Plain and polite",
                playbook: "e2e-sweep",
                reason: "ask the vendor",
              },
            },
            {
              tool: "majhi_playbooks_report",
              args: {
                run: 1,
                outcome: "done",
                summary: "One outdated package; a note is drafted.",
                reason: "done",
              },
            },
            { say: "Reported." },
          ],
        },
      ],
      { task: chat, onResult: (r) => seen.push(r.text) },
    );
    expect((await h.cmd("playbooks.update", { org: "acme", id: "e2e-sweep", enabled: true })).status).toBe(
      200,
    );
    const started = await h.cmd("playbooks.run", { org: "acme", id: "e2e-sweep" });
    expect(started.body).toMatchObject({ started: true });

    const calls = await script.calls(3);
    expect(calls.map((c) => [c.tool, c.isError])).toEqual([
      ["majhi_findings_report", false],
      ["majhi_outbound_submit", false],
      ["majhi_playbooks_report", false],
    ]);

    // The finding carries the playbook that filed it.
    const finding = ((await h.cmd("findings.list", { org: "acme" })).body as FindingsList).findings.find(
      (f: Finding) => f.source === "dependency",
    );
    expect(finding).toMatchObject({
      playbook: "e2e-sweep",
      severity: "medium",
      by: "captain",
      status: "open",
    });

    // The message did not go anywhere: it is a draft in Decisions with its text, target and voice.
    const drafts = await outbound(world);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      status: "pending",
      mode: "draft",
      channel: "email",
      target: "support@vendor.example",
      voice: "Plain and polite",
      by: "captain",
    });
    const decision = (await decisions(world)).find((d) => d.kind === "draft");
    expect(decision).toMatchObject({
      id: "draft:1",
      org: "acme",
      options: [{ id: "send", primary: true }, { id: "discard" }],
    });
    expect(decision?.title).toContain("support@vendor.example");
    const detail = await h.cmd("decisions.detail", { id: "draft:1" });
    expect((detail.body as { draft: Draft }).draft.body).toContain("upgrade notes");

    // The run is closed with its finding; the view counts it.
    const [run] = await runs(world);
    expect(run).toMatchObject({
      status: "done",
      findings: 1,
      note: "One outdated package; a note is drafted.",
    });
    const view = ((await h.cmd("playbooks.list", { org: "acme" })).body as PlaybooksList).playbooks.find(
      (p) => p.playbook.id === "e2e-sweep",
    );
    expect(view).toMatchObject({ enabled: true, running: false, counters: { ran: 1, findings: 1 } });

    // The owner approves. No sender is connected, so it says that and sends nothing.
    const answered = await h.cmd("decisions.answer", { id: "draft:1", option: "send" });
    expect(answered.status).toBe(200);
    const [after] = await outbound(world);
    expect(after?.status).toBe("approved");
    expect(after?.result).toMatch(/no sender is connected/);
    expect((await decisions(world)).some((d) => d.kind === "draft")).toBe(false);
  });

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
    expect(seen.slice(1, 3)).toEqual([
      "Turning an outcome rule on is the owner's, on the Playbooks page.",
      "outbound.setMode is the owner's. The owner sets a channel's mode and sends or discards drafts on Playbooks (/playbooks).",
    ]);

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
    expect(view?.held).toMatch(/Backing off/);
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
    expect(off).toMatchObject({ started: false, text: "Auto-pilot is off." });
    expect(await runs(world)).toEqual([]);
  });
});

describe("the upkeep chores on playbooks", () => {
  it("shows the chores as the Upkeep pack, and a chore turned off does not run, by schedule or by hand", async () => {
    const { h } = await lane();
    const list = (await h.cmd("playbooks.list", { org: "acme" })).body as PlaybooksList;
    const upkeep = list.playbooks.filter((p) => p.playbook.pack === "upkeep");
    expect(upkeep.map((p) => p.playbook.runner)).toHaveLength(12);
    expect(upkeep.every((p) => p.enabled)).toBe(true);

    await h.cmd("playbooks.update", { org: "acme", id: "upkeep-triage", enabled: false });
    const { captain } = h.majhi.services;
    await captain.sweepNow();
    await captain.settled();
    expect(captain.repo.runCount("acme", "triage")).toBe(0);
    expect(captain.repo.runCount("acme", "cleanup")).toBe(1);
    const manual = await h.cmd("playbooks.run", { org: "acme", id: "upkeep-triage" });
    expect(manual.body).toMatchObject({ started: false });
    expect(captain.repo.runCount("acme", "triage")).toBe(0);

    // Turned on again, the next sweep runs it once, as before.
    await h.cmd("playbooks.update", { org: "acme", id: "upkeep-triage", enabled: true });
    await captain.sweepNow();
    await captain.settled();
    expect(captain.repo.runCount("acme", "triage")).toBe(1);
  });
});
