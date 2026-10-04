import type { CaptainLogResult, OwnerDecision, Scorecard } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import { captainScript } from "../testing/captainScript.ts";

/**
 * Outcomes through a real captain turn of the fake agent's script mode: the lane files tasks, the
 * triage chore acts on them, the owner undoes most of it, and the trust ladder drops the Upkeep row
 * to You and says so in Decisions. Nothing here spends a token.
 */

let w: BossWorld | undefined;
const clock = { at: new Date("2026-10-06T08:00:00.000Z") };
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
  clock.at = new Date("2026-10-06T08:00:00.000Z");
});

const decisions = async (world: BossWorld): Promise<OwnerDecision[]> =>
  ((await world.h.cmd("decisions.list", {})).body as { decisions: OwnerDecision[] }).decisions;

describe("outcomes and the trust ladder in a real captain turn", { timeout: 120_000 }, () => {
  it("drops a row the owner keeps undoing, with the evidence in one Decisions item, and never promotes by itself", async () => {
    w = await bossWorld({ runClock: () => clock.at });
    const { h } = w;
    const { outcomes, captain, store, autonomy } = h.majhi.services;
    expect((await h.cmd("trust.setWindow", { window: 5 })).body).toEqual({ window: 5 });
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");

    // The captain's own turn files five tasks (it starts none).
    const said: string[] = [];
    const script = await captainScript(
      w,
      [
        {
          when: /Wake: tasks/,
          steps: [1, 2, 3, 4, 5].map((n) => ({
            tool: "majhi_tasks_create",
            args: {
              text: `Tidy item ${n}`,
              repos: [{ project: "acme-api" }],
              start: false,
              reason: "backlog",
            },
          })),
        },
      ],
      { task: chat, onResult: (r) => said.push(r.text) },
    );
    await h.majhi.services.lanes.tell("acme", "Wake: tasks", "wake");
    const made = await script.calls(5);
    expect(said.filter((t) => t.startsWith("Refused") || t.startsWith("Invalid"))).toEqual([]);
    expect(made.every((c) => !c.isError)).toBe(true);
    const tasks = store.tasks.list(false).filter((t) => t.title.startsWith("Tidy item"));
    expect(tasks).toHaveLength(5);

    // They are due tomorrow: the triage chore sets each to high priority, with an Undo.
    for (const t of tasks) {
      expect((await h.cmd("tasks.update", { id: t.id, due: "2026-10-07" })).status).toBe(200);
    }
    await captain.runner.start("acme", "triage", "test run");
    await captain.settled();
    const log = (await h.cmd("captain.log", { org: "acme", limit: 50 })).body as CaptainLogResult;
    const set = log.actions.filter((a) => a.text.includes("to high priority"));
    expect(set).toHaveLength(5);
    expect(set.every((a) => a.undo === "yes")).toBe(true);

    // The owner takes four back, an hour later.
    clock.at = new Date("2026-10-06T09:00:00.000Z");
    for (const a of set.slice(0, 4)) expect((await h.cmd("captain.undo", { id: a.id })).status).toBe(200);

    // Seven hours on, the one nobody touched counts as kept.
    clock.at = new Date("2026-10-06T16:30:00.000Z");
    await outcomes.sweep();
    for (const a of set.slice(0, 4)) expect(outcomes.repo.get(`action:${a.id}`)?.result).toBe("undone");
    expect(outcomes.repo.get(`action:${set[4]?.id}`)?.result).toBe("kept");

    const card = (await h.cmd("scorecard.get", { range: "week", org: "acme" })).body as Scorecard;
    const upkeep = card.rows.find((r) => r.key === "upkeep");
    expect(upkeep?.tally).toMatchObject({ actions: 5, judged: 5, kept: 1, overruled: 4, keptPct: 20 });
    expect(upkeep?.note).toBe("Dropped to You by the trust ladder");

    // The row went back to You by itself, and one Decisions item says why, with the evidence.
    const settings = (await h.cmd("autonomy.status")).body.settings.orgs.acme.authority;
    expect(settings.upkeep).toBe("ask");
    expect(settings.start).toBe("decide");
    const trust = (await decisions(w)).filter((d) => d.kind === "trust");
    expect(trust).toHaveLength(1);
    expect(trust[0]?.title).toBe("Acme: Upkeep went back to You. Only 1 of the last 5 were kept (20%).");
    expect(trust[0]?.sentence).toMatch(/Set .* to high priority/);
    expect(trust[0]?.sentence).toContain("undone");

    // Sweeping again changes nothing: one notice, one demotion.
    await outcomes.sweep();
    expect((await decisions(w)).filter((d) => d.kind === "trust")).toHaveLength(1);

    // The lane's own tools cannot touch the ladder, the ceiling or its own scorecard minutes.
    const seen: string[] = [];
    const attempts = await captainScript(
      w,
      [
        {
          when: /Wake: trust/,
          steps: [
            { tool: "majhi_money_set", args: { ceilingUsd: 100000, reason: "more room" } },
            { tool: "majhi_trust_setWindow", args: { window: 3, reason: "faster demotions" } },
            {
              tool: "majhi_scorecard_setMinutes",
              args: { kind: "merge", minutes: 600, reason: "look good" },
            },
            { tool: "majhi_scorecard_get", args: { range: "week", org: "globex", reason: "peek" } },
          ],
        },
      ],
      { task: chat, onResult: (r) => seen.push(r.text) },
    );
    await h.majhi.services.lanes.tell("acme", "Wake: trust", "wake");
    // The harness counts every call of the session: the first five were the tasks.
    const results = (await attempts.calls(9)).slice(5);
    expect(seen.slice(-4)).toEqual([
      "money.set is the owner's. The captain never changes its own trust or ceiling.",
      "trust.setWindow is the owner's. The captain never changes its own trust or ceiling.",
      "scorecard.setMinutes is the owner's. The captain never changes its own trust or ceiling.",
      "Refused: this lane works in Acme only and cannot read globex. Each workspace has its own lane.",
    ]);
    expect(results.every((c) => c.isError)).toBe(true);
    expect((await h.cmd("money.get", {})).body.ceilingUsd).toBeUndefined();
    expect(outcomes.window).toBe(5);

    // The owner gives the row back: the old record does not demote it again.
    const id = trust[0]?.id ?? "";
    expect((await h.cmd("decisions.answer", { id, option: "restore" })).status).toBe(200);
    const after = (await h.cmd("autonomy.status")).body.settings.orgs.acme.authority;
    expect(after.upkeep).toBe("decide");
    clock.at = new Date("2026-10-06T18:00:00.000Z");
    await outcomes.sweep();
    expect((await h.cmd("autonomy.status")).body.settings.orgs.acme.authority.upkeep).toBe("decide");
    expect((await decisions(w)).filter((d) => d.kind === "trust")).toEqual([]);
  });

  it("holds a captain start at the ceiling and lets the running turn finish", async () => {
    w = await bossWorld({ runClock: () => clock.at });
    const { h } = w;
    const { autonomy, store } = h.majhi.services;
    expect((await h.cmd("autonomy.configure", { orgs: { acme: { authority: RUNS } } })).status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    expect((await h.cmd("money.set", { ceilingUsd: 10 })).status).toBe(200);
    // Spend is over the ceiling: a turn recorded after the start crossed it.
    store.raw
      .prepare(
        `INSERT INTO turns (at, task, agent, account, tool, auth, org, input_tokens, output_tokens, reasoning_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, cost_source, estimated)
         VALUES (?, 'ACM-1', 'acme-builder', 'claude-acme', 'claude', 'oauth', 'acme', 1, 1, 0, 0, 0, 12, 'reported', 0)`,
      )
      .run(new Date(clock.at.getTime() - 1000).toISOString());
    clock.at = new Date(clock.at.getTime() + 60_000);
    expect(await autonomy.laneRest("acme", "claude-acme")).toMatch(/monthly ceiling of \$10\.00 is reached/);
    // It is not one of the day or workspace holds: nothing that runs is paused by it.
    expect((await h.cmd("autonomy.status")).body.holds).toEqual([]);
    // The owner is asked as a Money decision, and raising lifts it for the month.
    const ask = (await decisions(w)).find((d) => d.id === "ceiling:2026-10");
    expect(ask).toMatchObject({ kind: "budget" });
    expect((await h.cmd("decisions.answer", { id: "ceiling:2026-10", option: "raise" })).status).toBe(200);
    expect(await autonomy.laneRest("acme", "claude-acme")).toBeUndefined();
  });
});
