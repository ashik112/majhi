import { fakeAdapter } from "@majhi/acp/testing";
import type { BudgetStatus } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

/** One fake turn is 1000 input + 200 output + 500 cache write = 1700 budget tokens, 4000 cache read left out. */
const TURN_TOKENS = 1700;

async function twoOrgs(): Promise<BossWorld> {
  w = await bossWorld();
  const { h } = w;
  h.env.runtime.adapters = {
    claude: fakeAdapter("claude", { signedIn: true, usageModel: "claude-sonnet-5-5", turnCost: 0.0125 }),
    codex: fakeAdapter("codex", { signedIn: true }),
  };
  const ok = async (name: string, body: unknown) => {
    const res = await h.cmd(name, body);
    if (res.status !== 200) throw new Error(`${name} failed: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  await ok("orgs.create", { id: "globex", name: "Globex", key: "GLX" });
  await ok("accounts.create", {
    id: "codex-globex",
    tool: "codex",
    org: "globex",
    auth: "api-key",
    apiKey: "test-key-globex-0000",
  });
  await ok("agents.create", {
    id: "globex-builder",
    frontmatter: { scope: "globex", role: "Builder", account: "codex-globex", perms: ["edit", "shell"] },
    instructions: "Build things.\n",
  });
  await w.addRepo("web");
  await ok("projects.register", { id: "globex-web", org: "globex", path: "~/Work/web", aliases: ["web"] });
  return w;
}

async function settle(): Promise<void> {
  await w.h.majhi.services.runs.idle();
  await w.h.majhi.services.usageRecorder.flush();
}

async function status(): Promise<BudgetStatus> {
  const res = await w.h.cmd("budgets.status", {});
  expect(res.status).toBe(200);
  return res.body as BudgetStatus;
}

async function systemLines(task: string): Promise<string[]> {
  return (await w.items(task)).flatMap((i) =>
    i.type === "system" && i.text.startsWith("Budget") ? [i.text] : [],
  );
}

describe("weekly budgets from real turns", () => {
  it("alerts per org at 80% and 100% once each, and leaves the other org alone", async () => {
    await twoOrgs();
    const { h } = w;
    // 2 turns of acme reach 3400 of 4000 (85%); a third reaches 5100 (127%).
    const set = await h.cmd("settings.set", {
      budgets: { orgs: { acme: { tokens: 4000 }, globex: { tokens: 1_000_000 } } },
    });
    expect(set.status).toBe(200);
    expect(set.body.budgets.orgs).toEqual({ acme: { tokens: 4000 }, globex: { tokens: 1_000_000 } });

    const made = await h.cmd("tasks.create", {
      text: "add a health endpoint to api from develop",
      start: true,
    });
    expect(made.status).toBe(200);
    await settle();
    expect(await systemLines("ACM-1")).toEqual([]);
    await h.cmd("room.send", { task: "ACM-1", text: "echo: and once more" });
    await settle();
    const lines80 = await systemLines("ACM-1");
    expect(lines80).toHaveLength(1);
    expect(lines80[0]).toContain("org acme is at 85% of its weekly budget (3.4k of 4k tokens)");

    await h.cmd("room.send", { task: "ACM-1", text: "echo: one more" });
    await settle();
    const lines = await systemLines("ACM-1");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("Budget limit reached: org acme is at 127%");
    // At 100% the runs of the org pause, so a fourth prompt waits.
    await h.cmd("room.send", { task: "ACM-1", text: "echo: yet another" });
    await settle();

    // A Globex turn does not touch Acme's alerts.
    await h.cmd("tasks.create", {
      text: "add a health endpoint to web from develop",
      agent: "globex-builder",
      start: true,
    });
    await settle();
    expect(await systemLines("GLX-1")).toEqual([]);

    const s = await status();
    const acme = s.rows.find((r) => r.id === "acme");
    const globex = s.rows.find((r) => r.id === "globex");
    expect(acme).toMatchObject({
      scope: "org",
      budget: { tokens: 4000 },
      used: { tokens: 3 * TURN_TOKENS },
      measure: "tokens",
    });
    expect(acme?.percent).toBeCloseTo(127.5);
    expect(acme?.alerts.map((a) => a.threshold)).toEqual([80, 100]);
    expect(acme?.paused).toBe(true);
    expect(acme?.resetsAt).toEqual(expect.any(String));
    expect(globex).toMatchObject({ alerts: [], paused: false });
    expect(globex?.used.tokens).toBeGreaterThan(0);

    // Raising the budget mid-week re-arms what is now under: 5100 of 6000 is 85%, so only 100 returns.
    // The paused run goes on with its waiting prompt, which takes the use to 113% and fires 100 again.
    const raised = await h.cmd("settings.set", { budgets: { orgs: { acme: { tokens: 6000 } } } });
    expect(raised.body.budgets.orgs).toEqual({ acme: { tokens: 6000 }, globex: { tokens: 1_000_000 } });
    await settle();
    const last = (await systemLines("ACM-1")).at(-1);
    expect(last).toContain("Budget limit reached: org acme is at 113%");
    expect((await status()).rows.find((r) => r.id === "acme")).toMatchObject({ paused: true });
  });

  it("checks an account budget in dollars, and lets the boss read the status without a card", async () => {
    await twoOrgs();
    const { h } = w;
    await h.cmd("settings.set", { budgets: { accounts: { "claude-acme": { cost: 0.02 } } } });
    await h.cmd("tasks.create", { text: "add a health endpoint to api from develop", start: true });
    await settle();
    await h.cmd("room.send", { task: "ACM-1", text: "echo: again" });
    await settle();
    // Two turns cost 0.025 of 0.02.
    const row = (await status()).rows[0];
    expect(row).toMatchObject({ scope: "account", id: "claude-acme", measure: "cost" });
    expect(row?.percent).toBeCloseTo(125);
    expect(row?.alerts.map((a) => a.threshold)).toEqual([80, 100]);

    await h.cmd("room.send", {
      task: w.chat.id,
      text: 'call: majhi_budgets_status {"ownerAsked":true,"reason":"the owner asked how the budgets stand"}',
    });
    await settle();
    const items = await w.items();
    const tool = items.find((i) => i.type === "tool" && i.title === "majhi_budgets_status");
    expect(tool).toMatchObject({ status: "completed" });
    expect(items.some((i) => i.type === "approval" && i.state === "pending")).toBe(false);
  });

  it("removes a budget with null and rejects one with neither tokens nor cost", async () => {
    await twoOrgs();
    const { h } = w;
    await h.cmd("settings.set", { budgets: { orgs: { acme: { tokens: 100 } } } });
    expect((await h.cmd("settings.set", { budgets: { orgs: { acme: {} } } })).status).toBe(400);
    const gone = await h.cmd("settings.set", { budgets: { orgs: { acme: null } } });
    expect(gone.status).toBe(200);
    expect(gone.body.budgets.orgs).toEqual({});
    expect((await status()).rows).toEqual([]);
  });
});
