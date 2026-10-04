import type { Draft, Finding, FindingsList, OutboundList, OwnerDecision, PlaybookRun } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";

/**
 * A real captain turn, scripted through the fake agent, runs the Opportunities playbook: it reads the
 * brief code collected, reports opportunities as findings, and offers a proposal that waits in Decisions
 * as a draft. Nothing is sent. A second turn that goes wrong (owner-only commands, another workspace, a
 * secret in a draft) changes nothing.
 */

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
  expect((await h.cmd("orgs.create", { id: "globex", name: "Globex", key: "GLX" })).status).toBe(200);
  const chat = await h.majhi.services.autonomy.laneChat("acme");
  if (chat === undefined) throw new Error("no lane for Acme");
  // What code will put in the brief: a shipped task, a product, a client with a main contact.
  const db = h.majhi.services.store.raw;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, title, brief, kind, org, status, folder, team, created_at, updated_at)
     VALUES ('ACM-900', 'Checkout rewrite', '', 'code', 'acme', 'done', 'x', '[]', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO audit (task, agent, kind, title, decision, by, at, detail, org)
     VALUES ('ACM-900', 'owner', 'merge', 'Merge of acme-shop', 'done', 'owner', ?, 'main', 'acme')`,
  ).run(new Date(Date.now() - 86_400_000).toISOString());
  const seed = async (name: string, input: Record<string, unknown>) => {
    const done = await h.cmd(name as never, input as never);
    expect(done.status).toBe(200);
  };
  await seed("kb.upsert", { kind: "product", title: "Acme storefront", body: "A shop for boat yards.", org: "acme" });
  await seed("crm.upsert", {
    name: "Ana Reyes",
    relation: "client",
    org: "acme",
    emails: ["ana@acme.example"],
    tags: ["main-contact"],
  });
  return { w, h, chat };
}

const findings = async (world: BossWorld) =>
  ((await world.h.cmd("findings.list", { org: "acme", source: "opportunity" })).body as FindingsList).findings;
const drafts = async (world: BossWorld) =>
  ((await world.h.cmd("outbound.list", { org: "acme" })).body as OutboundList).drafts;
const runs = async (world: BossWorld) =>
  (await world.h.cmd("playbooks.runs", { org: "acme", id: "growth-opportunities" })).body.runs as PlaybookRun[];

describe("the Opportunities playbook through a captain turn", () => {
  it("reads the brief, files opportunities, a reworded one next time is the same, and a proposal waits in Decisions as a draft", async () => {
    const { w: world, h, chat } = await lane();
    const script = await captainScript(
      world,
      [
        {
          // Only a wake that carries the collected brief matches.
          when: /Playbook "Opportunities" is due in [\s\S]*kind="opportunities-brief"[\s\S]*Checkout rewrite[\s\S]*Acme storefront/,
          steps: [
            {
              tool: "majhi_findings_report",
              args: {
                source: "opportunity",
                title: "Offer a maintenance retainer for the shop",
                detail: "Effort: small. The checkout shipped last week; a retainer would keep it healthy.",
                evidence: ["ACM-900 Checkout rewrite", "KB 1 Acme storefront"],
                playbook: "growth-opportunities",
                reason: "upsell",
              },
            },
            {
              tool: "majhi_findings_report",
              args: {
                source: "opportunity",
                title: "Preview environments for every pull request",
                detail: "Effort: medium. Reviews wait on local checkouts.",
                evidence: ["owner time on ACM-900"],
                playbook: "growth-opportunities",
                reason: "process",
              },
            },
            {
              tool: "majhi_outbound_submit",
              args: {
                channel: "email",
                target: "ana@acme.example",
                subject: "Keeping the shop healthy",
                body: "Hello Ana, the new checkout is live. I would like to offer a small monthly plan to keep it fast and updated. Could we talk this week? Best, Sam",
                finding: 1,
                playbook: "growth-opportunities",
                reason: "proposal for the best upsell",
              },
            },
            {
              tool: "majhi_playbooks_report",
              args: { run: 1, outcome: "done", summary: "Two opportunities, one proposal drafted.", reason: "done" },
            },
            { say: "Reported." },
          ],
        },
      ],
      { task: chat },
    );
    expect((await h.cmd("playbooks.update", { org: "acme", id: "growth-opportunities", enabled: true })).status).toBe(
      200,
    );
    expect((await h.cmd("playbooks.run", { org: "acme", id: "growth-opportunities" })).body).toMatchObject({
      started: true,
    });
    const calls = await script.calls(4);
    expect(calls.map((c) => [c.tool, c.isError])).toEqual([
      ["majhi_findings_report", false],
      ["majhi_findings_report", false],
      ["majhi_outbound_submit", false],
      ["majhi_playbooks_report", false],
    ]);

    const opps = await findings(world);
    expect(opps.map((f: Finding) => [f.title, f.by, f.playbook])).toEqual(
      expect.arrayContaining([
        ["Offer a maintenance retainer for the shop", "captain", "growth-opportunities"],
        ["Preview environments for every pull request", "captain", "growth-opportunities"],
      ]),
    );
    expect(opps).toHaveLength(2);

    // The proposal is a draft in Decisions in Draft mode: it waits, and nothing left the machine.
    const [draft] = await drafts(world);
    expect(draft).toMatchObject<Partial<Draft>>({
      status: "pending",
      mode: "draft",
      channel: "email",
      target: "ana@acme.example",
      finding: 1,
      by: "captain",
    });
    const inbox = (await h.cmd("decisions.list", {})).body.decisions as OwnerDecision[];
    expect(inbox.find((d) => d.kind === "draft")).toMatchObject({ id: "draft:1", org: "acme" });
    const answered = await h.cmd("decisions.answer", { id: "draft:1", option: "send" });
    expect(answered.status).toBe(200);
    expect((await drafts(world))[0]?.result).toMatch(/no sender is connected/);

    const [run] = await runs(world);
    expect(run).toMatchObject({ status: "done", findings: 2 });

    // Next week the captain words an old idea differently: it is the same finding, and a new one is added.
    await captainScript(
      world,
      [
        {
          when: /Playbook "Opportunities" is due in /,
          steps: [
            {
              tool: "majhi_findings_report",
              args: {
                source: "opportunity",
                title: "Add a maintenance retainer for the shop",
                detail: "Effort: small. Still true.",
                evidence: ["ACM-900"],
                reason: "again",
              },
            },
            {
              tool: "majhi_findings_report",
              args: {
                source: "opportunity",
                title: "Move the cart to server components",
                detail: "Effort: large. React 19 would remove the fetch code.",
                evidence: ["radar"],
                reason: "feature",
              },
            },
            { tool: "majhi_playbooks_report", args: { run: 2, outcome: "done", reason: "done" } },
            { say: "Reported." },
          ],
        },
      ],
      { task: chat },
    );
    // The first run is closed; this is the owner asking again.
    expect((await h.cmd("playbooks.run", { org: "acme", id: "growth-opportunities" })).body).toMatchObject({
      started: true,
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && (await findings(world)).length < 3) await new Promise((r) => setTimeout(r, 100));
    const after = await findings(world);
    expect(after.map((f) => f.title).sort()).toEqual([
      "Move the cart to server components",
      "Offer a maintenance retainer for the shop",
      "Preview environments for every pull request",
    ]);
    expect(after.find((f) => f.title.startsWith("Offer a maintenance"))?.seen).toBe(2);
  });

  it("a turn that goes wrong changes nothing: owner-only commands, another workspace's numbers, and a secret in a draft are all refused", async () => {
    const { w: world, h, chat } = await lane();
    const script = await captainScript(
      world,
      [
        {
          when: /Playbook "Opportunities" is due in /,
          steps: [
            { tool: "majhi_findings_proposal", args: { id: 1, reason: "draft it myself" } },
            { tool: "majhi_findings_deadline", args: { id: 1, reason: "add it" } },
            { tool: "majhi_economics_get", args: { range: "week", org: "globex", reason: "peek" } },
            {
              tool: "majhi_outbound_submit",
              args: {
                channel: "email",
                target: "ana@acme.example",
                subject: "Key",
                body: "Here is the key: AKIAIOSFODNN7EXAMPLE",
                reason: "oops",
              },
            },
            { tool: "majhi_economics_get", args: { range: "week", reason: "my own" } },
            { tool: "majhi_playbooks_report", args: { run: 1, outcome: "nothing", reason: "done" } },
          ],
        },
      ],
      { task: chat },
    );
    await h.cmd("playbooks.update", { org: "acme", id: "growth-opportunities", enabled: true });
    await h.cmd("playbooks.run", { org: "acme", id: "growth-opportunities" });
    const calls = await script.calls(6);
    expect(calls.map((c) => c.isError)).toEqual([true, true, true, true, false, false]);
    expect(calls[2]?.text).toMatch(/works in Acme only/);
    expect(calls[3]?.text).toMatch(/looks like a secret/);
    expect(await findings(world)).toEqual([]);
    expect(await drafts(world)).toEqual([]);
    // The economics it read was its own workspace's.
    expect(calls[4]?.text).toContain('"org": "acme"');
    expect(calls[4]?.text).not.toContain("globex");
  });

  it("does not wake the captain while the playbook is off", async () => {
    const { w: world, h } = await lane();
    expect((await h.cmd("playbooks.run", { org: "acme", id: "growth-opportunities" })).body).toMatchObject({
      started: false,
    });
    expect(await runs(world)).toEqual([]);
    const view = (await h.cmd("playbooks.list", { org: "acme" })).body.playbooks.find(
      (p: { playbook: { id: string } }) => p.playbook.id === "growth-opportunities",
    );
    expect(view).toMatchObject({ enabled: false });
  });
});
