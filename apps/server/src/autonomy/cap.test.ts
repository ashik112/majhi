import type { AutonomyStatus, BudgetAsk, RoomItem, Task } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { RUNS } from "../captain/authority-fixtures.ts";
import { type BossWorld, bossWorld } from "../testing/boss.ts";
import type { FakeSession, Turn } from "../testing/fakeSession.ts";
import { CAP_MARGIN } from "./spend.ts";

/**
 * The day cap is a hard stop (PRV-74, rule 6): no turn starts once it is reached, and a turn that
 * runs long stops at a tool call once the day's spend, with what it spent so far, passed the cap by
 * more than the margin. The agent here is the in-memory fake: it spends no tokens, it only reports a
 * running cost that grows with each tool call, like claude-agent-acp does.
 */

let w: BossWorld | undefined;
afterEach(async () => {
  await w?.cleanup();
  w = undefined;
});

const CAP = 1;
/** Dollars each tool call adds to the running cost. */
const STEP = 0.02;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A long turn: a tool call and a higher running cost, one after the other, until it is cancelled. After
 * each one `settle` lets what the cost set off (the usage record, the cap, the cancel) finish, so how far
 * the cost runs past the cap depends on the code, never on how fast the machine is. Reports its cost at
 * the end.
 */
async function spender(turn: Turn, spent: { usd: number }, settle: () => Promise<void>): Promise<"end_turn"> {
  let cancelled = false;
  void turn.untilCancelled().then(() => {
    cancelled = true;
  });
  let cost = 0;
  for (let i = 0; i < 2000 && !cancelled; i++) {
    cost = Math.round((cost + STEP) * 100) / 100;
    turn.emit({ type: "usage", used: 10_000, size: 200_000, cost: { amount: cost, currency: "USD" } });
    turn.emit({ type: "tool", toolCallId: `t${i}`, title: "Edit a file", kind: "edit", status: "completed" });
    await settle();
  }
  spent.usd = cost;
  turn.emit({
    type: "turn",
    usage: {
      inputTokens: 1000,
      outputTokens: 100,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reported: true,
      costUsd: cost,
    },
  });
  return "end_turn";
}

describe("the day cap of autonomous mode", () => {
  it("stops a running turn once the cap is passed by more than the margin, and starts nothing after", async () => {
    w = await bossWorld({ real: false });
    const { h } = w;
    const sessions: FakeSession[] = [];
    const spent = { usd: 0 };
    h.runtime.onSession = (session) => {
      sessions.push(session);
      session.script = async (turn) => {
        if (sessions.indexOf(session) === 0 && session.prompts.length === 1)
          return spender(turn, spent, async () => {
            await h.majhi.services.usageRecorder.flush();
            await new Promise((r) => setImmediate(r));
          });
        turn.emit({ type: "text", messageId: `m${session.prompts.length}`, text: "ok" });
        return "end_turn";
      };
    };
    const configured = await h.cmd("autonomy.configure", {
      day: { cost: CAP },
      orgs: { acme: { authority: RUNS } },
    });
    expect(configured.status).toBe(200);
    expect((await h.cmd("autonomy.start")).status).toBe(200);
    const chat = await h.majhi.services.autonomy.laneChat("acme");
    if (chat === undefined) throw new Error("no lane for Acme");
    const made = await h.majhi.services.admin.call({ task: chat, agent: "boss" }, "majhi_tasks_create", {
      text: "fix the api",
      repos: [{ project: "acme-api" }],
      start: true,
      reason: "the top task of the backlog",
    });
    expect(made.isError).toBe(false);
    const id = (JSON.parse(made.text) as { id: string }).id;
    const task = (): Task | undefined => h.majhi.services.store.tasks.get(id);

    await w.until(() => task()?.status === "paused", "the cap to stop the turn");
    await h.majhi.services.runs.idle();
    await h.majhi.services.usageRecorder.flush();
    await h.majhi.services.autonomy.refreshHolds();
    expect(task()?.pausedReason).toBe("limit");
    expect(h.majhi.services.autonomy.repo.task(id)?.held).toBe("limit");
    // The paused card names the cap that stopped it, not a generic budget.
    const items = (await h.cmd("room.items", { task: id, limit: 500 })).body.items as RoomItem[];
    const card = items.find((i) => i.type === "paused" && i.state === "pending");
    expect(card?.type === "paused" && card.why).toContain("Waiting for the autonomous daily budget, $");

    const status = (await h.cmd("autonomy.status", { detail: true })).body as AutonomyStatus;
    const used = status.spend.total.used.cost;
    // Past the cap, and over it by no more than the margin and the tool call that crossed it.
    expect(used).toBeGreaterThan(CAP);
    expect(used).toBeLessThanOrEqual(CAP * (1 + CAP_MARGIN) + 2 * STEP + 1e-9);
    expect(spent.usd).toBe(used);
    expect(status.holds.map((x) => x.kind)).toContain("day-cap");

    // Nothing more is sent: the gate holds every new turn.
    const prompts = sessions.reduce((n, s) => n + s.prompts.length, 0);
    h.majhi.services.runs.notify(id, task()?.team[0] ?? "", "one more thing");
    await pause(100);
    await h.majhi.services.runs.idle();
    expect(sessions.reduce((n, s) => n + s.prompts.length, 0)).toBe(prompts);

    // The owner is asked once, with the doubled budget, and the answer lifts the hold for today only.
    const asked = async () => (await h.cmd("captain.asks")).body.budgets as BudgetAsk[];
    expect(await asked()).toMatchObject([
      { scope: "day", name: "Auto-pilot work", cap: { cost: CAP }, raiseTo: { cost: CAP * 2 }, waiting: 1 },
    ]);
    await h.majhi.services.autonomy.refreshHolds();
    expect(await asked()).toHaveLength(1);
    const answered = await h.cmd("captain.answerBudget", { scope: "day", answer: "raise" });
    expect(answered.status).toBe(200);
    expect(answered.body.budgets).toEqual([]);
    const after = (await h.cmd("autonomy.status", { detail: true })).body as AutonomyStatus;
    expect(after.holds.map((x) => x.kind)).not.toContain("day-cap");
    expect(after.spend.total.cap).toEqual({ cost: CAP * 2 });
    expect(after.raised).toEqual({ day: { cost: CAP * 2 } });
    // The saved budget is the owner's number still.
    expect(after.settings.day).toEqual({ cost: CAP });
    expect(h.majhi.services.autonomy.repo.task(id)?.held).toBeUndefined();
    // Answered once: no second question that day, and a second answer is refused.
    expect(await asked()).toEqual([]);
    expect((await h.cmd("captain.answerBudget", { scope: "day", answer: "raise" })).status).toBe(409);
  });
});
