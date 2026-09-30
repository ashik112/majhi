import { type APIRequestContext, expect, type Page, test } from "@playwright/test";

// Tokens and cost (Phase 2c). Builds on the earlier phases: Acme's agents have run turns on the
// Claude fake, which reports tokens and a running cost. This spec adds Northwind with a Codex
// API-key account (tokens, no cost), prices its model, runs a task, and checks that the page and
// the boss show the sum of the recorded turns.
test.describe.configure({ mode: "serial" });

async function cmd<T>(request: APIRequestContext, name: string, data: object): Promise<T> {
  const res = await request.post(`/api/cmd/${name}`, { data });
  expect(res.ok(), `${name}: ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

interface Row {
  org: string | null;
  project: string | null;
  agent: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}
type Totals = {
  turns: number;
  totalTokens: number;
  costUsd: number;
};

const rows = (request: APIRequestContext, filters: object = {}) =>
  cmd<Row[]>(request, "usage.turns", { filters, limit: 500 });

function sum(list: Row[]): Totals {
  const cost = list.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  return {
    turns: list.length,
    totalTokens: list.reduce(
      (a, r) => a + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      0,
    ),
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
  };
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const money = (usd: number) => (usd <= 0 ? "$0.00" : usd < 0.01 ? "<$0.01" : USD.format(usd));
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/${name}.png` });

test.beforeAll(async ({ request }) => {
  const orgs = await cmd<{ id: string }[]>(request, "orgs.list", {});
  if (!orgs.some((o) => o.id === "northwind")) {
    await cmd(request, "orgs.create", { id: "northwind", name: "Northwind", key: "NW" });
  }
  await cmd(request, "accounts.create", {
    id: "codex-northwind",
    tool: "codex",
    org: "northwind",
    auth: "api-key",
    apiKey: "test-northwind-key-0000",
  });
  await cmd(request, "projects.register", {
    id: "web",
    org: "northwind",
    path: "~/Work/beta-web",
    aliases: ["frontend"],
  });
  await cmd(request, "agents.create", {
    id: "northwind-builder",
    frontmatter: {
      scope: "northwind",
      role: "Builder",
      account: "codex-northwind",
      perms: ["edit", "shell"],
    },
    instructions: "Build things.",
  });
  // The Codex fake reports no cost, so its model is priced from the table.
  await cmd(request, "usage.setPrice", {
    model: "fake-model-a",
    price: { input: 2, output: 10, cache_read: 0.2, cache_write: 0 },
  });
});

test("after runs on two orgs, the totals per org, project, agent and model are the sum of the recorded turns", async ({
  page,
  request,
}) => {
  const task = await cmd<{ id: string }>(request, "tasks.create", {
    text: "add a health endpoint to web @northwind-builder",
    start: true,
  });
  await expect
    .poll(async () => (await rows(request, { task: task.id })).length, { timeout: 30_000 })
    .toBeGreaterThan(0);

  const acme = await rows(request, { org: "acme" });
  const northwind = await rows(request, { org: "northwind" });
  expect(acme.length).toBeGreaterThan(0);
  expect(northwind[0]).toMatchObject({ project: "web", agent: "northwind-builder", model: "fake-model-a" });
  expect(northwind[0]?.costUsd).toBeGreaterThan(0);

  const all = await rows(request);
  expect(all.length).toBeLessThan(500);
  for (const by of ["org", "project", "agent", "model"] as const) {
    const res = await cmd<{ total: Totals; rows: { key: string | null; totals: Totals }[] }>(
      request,
      "usage.breakdown",
      {
        by,
        range: "all",
        limit: 500,
      },
    );
    expect(res.total).toMatchObject(sum(all));
    for (const row of res.rows) {
      expect(row.totals, `${by} ${row.key}`).toMatchObject(
        sum(all.filter((r) => (r[by] ?? null) === row.key)),
      );
    }
  }

  // The page shows the same numbers, per org, under the sidebar's org filter.
  const section = page.getByRole("region", { name: "Tokens and cost" });
  for (const [org, list] of [
    ["northwind", northwind],
    ["acme", acme],
  ] as const) {
    await page.goto(`/usage?org=${org}`);
    const month = sum(list);
    const tile = section.getByRole("region", { name: "This month" });
    await expect(tile).toContainText(money(month.costUsd));
    await expect(tile).toContainText(`${month.turns} turn`);
  }
  await page.goto("/usage?org=northwind");
  await shot(page, "usage-northwind");

  // The task view shows the task's own total.
  await page.goto(`/t/${task.id}`);
  const taskCost = sum(await rows(request, { task: task.id })).costUsd;
  await expect(page.getByText(money(taskCost)).first()).toBeVisible();
});

test("the boss answers a cost question from the same numbers", async ({ request }) => {
  const chat = await cmd<{ id: string }>(request, "boss.chat", {});
  const week = (await cmd<{ week: Totals }>(request, "usage.summary", { filters: { org: "northwind" } }))
    .week;
  await cmd(request, "room.send", {
    task: chat.id,
    text: 'call: majhi_usage_summary {"filters":{"org":"northwind"},"ownerAsked":true,"reason":"What did Northwind cost this week?"}',
  });
  let answer: { week: Totals } | undefined;
  await expect
    .poll(
      async () => {
        const page = await cmd<{
          items: {
            type: string;
            title?: string;
            status?: string;
            content?: { type: string; text?: string }[];
          }[];
        }>(request, "room.items", { task: chat.id, limit: 500 });
        const tool = page.items.find(
          (i) => i.type === "tool" && i.title === "majhi_usage_summary" && i.status === "completed",
        );
        const text = tool?.content?.[0]?.text;
        answer = text === undefined ? undefined : (JSON.parse(text) as { week: Totals });
        return answer !== undefined;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  expect(answer?.week).toMatchObject({
    turns: week.turns,
    totalTokens: week.totalTokens,
    costUsd: week.costUsd,
  });
});
