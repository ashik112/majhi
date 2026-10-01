import { fakeAdapter } from "@majhi/acp/testing";
import type { TurnRow, UsageTotals } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { type BossWorld, bossWorld } from "../testing/boss.ts";

let w: BossWorld;
afterEach(() => w?.cleanup());

const CLAUDE_COST = 0.0125;

/** Acme (Claude, sign-in, reports cost) and Globex (Codex, API key, no cost reported), each with a project and an agent. */
async function twoOrgs(): Promise<BossWorld> {
  w = await bossWorld();
  const { h } = w;
  h.env.runtime.adapters = {
    claude: fakeAdapter("claude", { signedIn: true, usageModel: "claude-sonnet-5-5", turnCost: CLAUDE_COST }),
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

async function rows(filters: Record<string, string> = {}): Promise<TurnRow[]> {
  const res = await w.h.cmd("usage.turns", { filters, limit: 500 });
  expect(res.status).toBe(200);
  return res.body as TurnRow[];
}

/** What the totals of these rows must be. */
function sum(
  list: TurnRow[],
): Pick<UsageTotals, "turns" | "inputTokens" | "outputTokens" | "totalTokens" | "costUsd"> {
  const cost = list.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  return {
    turns: list.length,
    inputTokens: list.reduce((a, r) => a + r.inputTokens, 0),
    outputTokens: list.reduce((a, r) => a + r.outputTokens, 0),
    totalTokens: list.reduce(
      (a, r) => a + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      0,
    ),
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
  };
}

describe("tokens and cost from real turns", () => {
  it("records every turn on two orgs, and every total matches the sum of the rows", async () => {
    await twoOrgs();
    const { h } = w;
    expect(
      (
        await h.cmd("tasks.create", {
          text: "add a health endpoint to api from develop",
          repos: [{ project: "acme-api", base: "develop" }],
          start: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.cmd("tasks.create", {
          text: "add a health endpoint to web from develop",
          agent: "globex-builder",
          start: true,
        })
      ).status,
    ).toBe(200);
    await settle();
    await h.cmd("room.send", { task: "ACM-1", text: "echo: and once more" });
    await settle();

    const acme = await rows({ org: "acme" });
    const globex = await rows({ org: "globex" });
    expect(acme).toHaveLength(2);
    expect(globex).toHaveLength(1);

    // Claude on a sign-in account: the reported cost, marked as the estimated API equivalent.
    for (const r of acme) {
      expect(r).toMatchObject({
        task: "ACM-1",
        agent: "acme-builder",
        account: "claude-acme",
        project: "acme-api",
        model: "claude-sonnet-5-5",
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 4000,
        cacheWriteTokens: 500,
        costSource: "reported",
        estimated: true,
      });
      expect(r.costUsd).toBeCloseTo(CLAUDE_COST);
    }
    // Codex reports no cost, and its model has no price yet.
    expect(globex[0]).toMatchObject({
      task: "GLX-1",
      project: "globex-web",
      model: "fake-model-a",
      reasoningTokens: 50,
      costUsd: null,
      costSource: "none",
    });

    // The owner prices the Codex model; new turns use it, recorded ones keep theirs.
    const priced = await h.cmd("usage.setPrice", {
      model: "fake-model-a",
      price: { input: 1, output: 10, cache_read: 0.1, cache_write: 0 },
    });
    expect(priced.status).toBe(200);
    expect(priced.body.rows[0]).toMatchObject({ model: "fake-model-a", source: "owner" });
    expect(priced.body.rows[0].url).toBeUndefined();
    // A default row names its page and check date; changing it makes it the owner's, without them.
    const table = await h.cmd("usage.prices", {});
    const own = { input: 9, output: 9, cache_read: 9, cache_write: 9 };
    const stock = table.body.rows.find((r: { model: string }) => r.model === "gpt-6-sol");
    expect(stock).toMatchObject({
      source: "default",
      url: expect.stringMatching(/^https:/),
      checked: expect.any(String),
    });
    const changed = await h.cmd("usage.setPrice", { model: "gpt-6-sol", price: own });
    expect(changed.body.rows.find((r: { model: string }) => r.model === "gpt-6-sol")).toMatchObject({
      source: "owner",
      overridesDefault: true,
      price: own,
    });
    expect(changed.body.rows.find((r: { model: string }) => r.model === "gpt-6-sol").url).toBeUndefined();
    await h.cmd("room.send", { task: "GLX-1", text: "echo: again" });
    await settle();
    const globexNow = await rows({ org: "globex" });
    expect(globexNow).toHaveLength(2);
    expect(globexNow[0]).toMatchObject({ costSource: "table", estimated: true });
    // 1000 * 1 + 200 * 10 + 4000 * 0.1 per million.
    expect(globexNow[0]?.costUsd).toBeCloseTo(0.0034);
    expect(globexNow[1]?.costUsd).toBeNull();

    // Summary, per org, per project, per agent and per model: each equals the sum of its rows.
    const all = await rows();
    for (const by of ["org", "project", "agent", "account", "model", "task"] as const) {
      const res = await h.cmd("usage.breakdown", { by, range: "today" });
      expect(res.status).toBe(200);
      expect(res.body.total).toMatchObject(sum(all));
      for (const row of res.body.rows as { key: string | null; totals: UsageTotals }[]) {
        const mine = all.filter((r) => (r[by] ?? null) === row.key);
        expect(row.totals, `${by} ${row.key}`).toMatchObject(sum(mine));
      }
      expect((res.body.rows as { totals: UsageTotals }[]).reduce((a, r) => a + r.totals.turns, 0)).toBe(
        all.length,
      );
    }
    const summary = await h.cmd("usage.summary", { filters: { org: "acme" } });
    expect(summary.body.today).toMatchObject(sum(acme));
    expect(summary.body.week).toMatchObject(sum(acme));
    expect(summary.body.month).toMatchObject(sum(acme));
    expect(summary.body.all).toMatchObject(sum(acme));
    expect(summary.body.today.estimatedUsd).toBeCloseTo(2 * CLAUDE_COST);
    expect(summary.body.days).toHaveLength(30);
    expect(summary.body.days.at(-1)).toMatchObject({ turns: 2 });
    expect(summary.body.topTasks).toMatchObject([{ task: "ACM-1", org: "acme" }]);
    const byDay = await h.cmd("usage.breakdown", { by: "day", range: "all" });
    expect(byDay.body.rows).toHaveLength(1);
    expect(byDay.body.rows[0].totals).toMatchObject(sum(all));
  });

  it("lets the boss answer a cost question from the same numbers", async () => {
    await twoOrgs();
    const { h } = w;
    await h.cmd("tasks.create", {
      text: "add a health endpoint to api from develop",
      repos: [{ project: "acme-api", base: "develop" }],
      start: true,
    });
    await settle();
    const acmeWeek = (await h.cmd("usage.summary", { filters: { org: "acme" } })).body.week as UsageTotals;
    expect(acmeWeek.turns).toBe(1);

    await h.cmd("room.send", {
      task: w.chat.id,
      text: 'call: majhi_usage_summary {"filters":{"org":"acme"},"ownerAsked":true,"reason":"the owner asked what Acme cost this week"}',
    });
    await settle();
    const items = await w.items();
    const tool = items.find((i) => i.type === "tool" && i.title === "majhi_usage_summary");
    expect(tool).toMatchObject({ status: "completed" });
    const text = tool?.type === "tool" && tool.content[0]?.type === "text" ? tool.content[0].text : "";
    const answer = JSON.parse(text) as { week: UsageTotals };
    expect(answer.week).toEqual(acmeWeek);
    // A read runs without a confirm card.
    expect(items.some((i) => i.type === "approval" && i.state === "pending")).toBe(false);
  });
});
